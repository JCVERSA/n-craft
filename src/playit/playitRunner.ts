import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '../preflight.ts';
import type { StateStore } from '../state.ts';
import { PlayitIpcClient } from './playitIpc.ts';

const ASSIGNED_ADDRESS = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:joinmc\.link|ply\.gg|playit\.gg)(?::\d{1,5})?)\b/i;

function readTimeout(name: string, fallback: number): number {
  const candidate = Number(process.env[name]);
  return Number.isSafeInteger(candidate) && candidate >= 1000 ? candidate : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Démarrage Playit annulé.');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Starts the current Playit 1.x daemon directly, without Docker-in-Docker or the CLI. */
export class PlayitRunner {
  private startedOnce = false;
  private shuttingDown = false;
  private child: ChildProcess | null = null;
  private ipcClient: PlayitIpcClient | null = null;
  private startupPromise: Promise<void> | null = null;
  private monitorPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private secretDirectory: string | null = null;
  private secretFilePath: string | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private addressTimeout: NodeJS.Timeout | null = null;
  private detectedAddressThisRun = false;
  private fatalLifecycleError: string | null = null;
  private preserveFailureOnExit = false;
  private readonly closedChildren = new WeakSet<ChildProcess>();
  private readonly startupController = new AbortController();
  private readonly addressTimeoutMs = readTimeout('PLAYIT_ADDRESS_TIMEOUT_MS', 25_000);
  private readonly startupTimeoutMs = readTimeout('PLAYIT_START_TIMEOUT_MS', 20_000);

  constructor(
    private readonly command: string,
    private readonly secretKey: string | undefined,
    private readonly state: StateStore,
  ) {}

  startOnce(): void {
    if (this.startedOnce || this.shuttingDown) return;
    this.startedOnce = true;
    this.detectedAddressThisRun = false;
    this.fatalLifecycleError = null;
    this.preserveFailureOnExit = false;

    const secret = this.secretKey?.trim();
    if (!secret) {
      void this.state.updatePlayit({
        status: 'configuration_missing',
        address: null,
        addressDetectedAt: null,
        error: 'PLAYIT_SECRET_KEY n’est pas configurée ; l’agent Playit n’a pas été lancé.',
        startedAt: null,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      return;
    }
    if (!/^(?:[0-9a-f]{2})+$/i.test(secret)) {
      void this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: 'PLAYIT_SECRET_KEY n’a pas le format hexadécimal attendu par playitd.',
        startedAt: null,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      return;
    }

    const executable = resolveExecutable(this.command);
    if (!executable) {
      void this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: `Binaire Playit daemon introuvable : ${this.command}. Aucun redémarrage automatique ne sera tenté.`,
        startedAt: null,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      return;
    }

    void this.state.updatePlayit({
      status: 'starting',
      address: null,
      addressDetectedAt: null,
      error: null,
      startedAt: new Date().toISOString(),
    }).catch((error) => console.error(`[playit] ${String(error)}`));

    this.startupPromise = this.startDaemon(executable, secret).catch(async (error) => {
      if (this.shuttingDown) return;
      const message = (error as Error).message || 'Échec du démarrage de Playit.';
      console.error(`[playit] ${message}`);
      this.preserveFailureOnExit = true;
      this.clearAddressTimeout();
      this.ipcClient?.close();
      this.ipcClient = null;
      await this.stopChild().catch((stopError) => {
        console.error(`[playit] ${String(stopError)}`);
      });
      await this.cleanupSecretDirectory();
      await this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: `Échec de démarrage de Playit (${message}). Aucun redémarrage automatique ne sera tenté.`,
      }).catch((persistError) => console.error(`[playit] ${String(persistError)}`));
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.clearAddressTimeout();
    this.startupController.abort(new Error('Arrêt du panneau : Playit annulé.'));
    this.ipcClient?.close();
    this.ipcClient = null;

    this.shutdownPromise = (async () => {
      await this.startupPromise?.catch(() => undefined);
      await this.monitorPromise?.catch(() => undefined);
      await this.stopChild();
      await this.cleanupSecretDirectory();
    })();
    return this.shutdownPromise;
  }

  private async startDaemon(executable: string, secret: string): Promise<void> {
    const signal = this.startupController.signal;
    this.secretDirectory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-'));
    await chmod(this.secretDirectory, 0o700);
    const secretPath = path.join(this.secretDirectory, 'secret.key');
    this.secretFilePath = secretPath;
    const socketPath = path.join(this.secretDirectory, 'playit.sock');
    await writeFile(secretPath, secret, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (signal.aborted) throw abortError(signal);

    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
    delete childEnvironment.PANEL_TOKEN;
    delete childEnvironment.PLAYIT_SECRET_KEY;

    let spawnError: Error | null = null;
    const child = spawn(executable, [
      '--secret-path', secretPath,
      '--socket-path', socketPath,
      '--platform-docker',
    ], {
      cwd: this.secretDirectory,
      env: childEnvironment,
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    child.once('error', (error) => {
      spawnError = error;
      if (!signal.aborted) this.startupController.abort(error);
    });
    child.once('close', (code, processSignal) => {
      this.closedChildren.add(child);
      if (this.child === child) this.child = null;
      this.clearAddressTimeout();
      this.ipcClient?.close();
      this.ipcClient = null;
      if (!spawnError && !this.preserveFailureOnExit) {
        const reason = processSignal ? `signal ${processSignal}` : `code ${code ?? 'inconnu'}`;
        void this.state.updatePlayit({
          status: 'exited',
          address: null,
          addressDetectedAt: null,
          error: `L’agent Playit s’est arrêté (${reason}). Il ne sera pas relancé automatiquement.`,
        }).catch((error) => console.error(`[playit] ${String(error)}`));
      }
      void this.cleanupSecretDirectory();
      if (!this.shuttingDown && !signal.aborted) {
        this.startupController.abort(new Error('Le processus playitd s’est arrêté avant de terminer sa connexion IPC.'));
      }
    });

    const ipc = await this.connectToDaemon(socketPath, signal);
    if (signal.aborted) {
      ipc.close();
      throw abortError(signal);
    }
    this.ipcClient = ipc;
    ipc.on('lifecycle', (lifecycle: unknown) => this.applyLifecycle(lifecycle));
    const subscription = await ipc.subscribe(signal, this.startupTimeoutMs);
    if (signal.aborted) throw abortError(signal);
    const subscriptionRecord = isRecord(subscription) ? subscription : {};
    const snapshot = isRecord(subscriptionRecord.snapshot) ? subscriptionRecord.snapshot : {};
    this.applyLifecycle(snapshot.lifecycle);
    if (isRecord(snapshot.status) && snapshot.status.has_secret === true) await this.removeSecretFile();
    if (signal.aborted) throw abortError(signal);
    if (this.fatalLifecycleError) throw new Error(this.fatalLifecycleError);

    if (!this.detectedAddressThisRun) {
      this.addressTimeout = setTimeout(() => {
        if (!this.child || this.shuttingDown) return;
        void this.state.updatePlayit({
          status: 'address_not_detected',
          address: null,
          addressDetectedAt: null,
          error: 'Tunnel Playit connecté, mais aucune adresse publique reconnue n’a été publiée via IPC dans le délai imparti.',
        }).catch((error) => console.error(`[playit] ${String(error)}`));
      }, this.addressTimeoutMs);
    }

    this.monitorPromise = ipc.monitor(signal).catch(async (error) => {
      if (this.shuttingDown || signal.aborted) return;
      this.clearAddressTimeout();
      this.preserveFailureOnExit = true;
      if (this.fatalLifecycleError) {
        await this.stopChild().catch((stopError) => console.error(`[playit] ${String(stopError)}`));
        return;
      }
      await this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: `Connexion IPC Playit perdue (${(error as Error).message}).`,
      }).catch((persistError) => console.error(`[playit] ${String(persistError)}`));
      await this.stopChild().catch((stopError) => console.error(`[playit] ${String(stopError)}`));
    });
  }

  private async connectToDaemon(socketPath: string, signal: AbortSignal): Promise<PlayitIpcClient> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: Error = new Error('Le socket IPC Playit n’est pas disponible.');
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError(signal);
      try {
        return await PlayitIpcClient.connect(socketPath, signal, Math.min(1000, deadline - Date.now()));
      } catch (error) {
        lastError = error as Error;
        if (signal.aborted) throw abortError(signal);
        await delay(100, signal);
      }
    }
    throw new Error(`Le socket IPC de playitd n’est pas devenu disponible (${lastError.message}).`);
  }

  private applyLifecycle(value: unknown): void {
    if (!isRecord(value) || typeof value.state !== 'string') return;
    const lifecycle = value.state;
    if (lifecycle === 'running') {
      void this.removeSecretFile();
      const data = isRecord(value.data) ? value.data : {};
      const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
      for (const tunnel of tunnels) {
        if (!isRecord(tunnel) || tunnel.is_disabled === true || typeof tunnel.display_address !== 'string') continue;
        const match = tunnel.display_address.match(ASSIGNED_ADDRESS);
        if (!match?.[1]) continue;
        this.detectedAddressThisRun = true;
        this.clearAddressTimeout();
        void this.state.updatePlayit({
          status: 'running',
          address: match[1],
          addressDetectedAt: new Date().toISOString(),
          error: null,
        }).catch((error) => console.error(`[playit] ${String(error)}`));
        return;
      }
      return;
    }

    if (lifecycle === 'waiting_for_secret' || lifecycle === 'has_invalid_secret' || lifecycle === 'disabled_over_limit' || lifecycle === 'error') {
      const detail = isRecord(value.data) && typeof value.data.message === 'string' ? value.data.message : 'playitd a signalé un état d’erreur.';
      this.fatalLifecycleError = detail;
      this.preserveFailureOnExit = true;
      this.clearAddressTimeout();
      void this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: detail,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      if (this.monitorPromise) {
        const ipc = this.ipcClient;
        this.ipcClient = null;
        ipc?.close();
      }
    }
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || this.closedChildren.has(child)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      await this.waitForChildClose(child, 5000);
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may have exited between the state check and the signal.
    }
    if (await this.waitForChildClose(child, 5000)) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // Check the child state after the bounded wait.
    }
    const stopped = await this.waitForChildClose(child, 5000);
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      throw new Error('playitd est toujours actif après SIGKILL.');
    }
  }

  private waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (this.closedChildren.has(child)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout;
      const finish = (closed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.removeListener('close', onClose);
        resolve(closed || this.closedChildren.has(child) || child.exitCode !== null || child.signalCode !== null);
      };
      const onClose = () => finish(true);
      child.once('close', onClose);
      timer = setTimeout(() => finish(false), timeoutMs);
      if (this.closedChildren.has(child)) finish(true);
    });
  }

  private async removeSecretFile(): Promise<void> {
    const filePath = this.secretFilePath;
    if (!filePath) return;
    try {
      await rm(filePath, { force: true });
      if (this.secretFilePath === filePath) this.secretFilePath = null;
    } catch (error) {
      console.error(`[playit] Could not remove temporary secret file: ${(error as Error).message}`);
    }
  }

  private async cleanupSecretDirectory(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const directory = this.secretDirectory;
    this.secretDirectory = null;
    this.secretFilePath = null;
    if (!directory) return;
    this.cleanupPromise = rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      .catch((error) => console.error(`[playit] Could not remove temporary secret directory: ${(error as Error).message}`));
    await this.cleanupPromise;
    this.cleanupPromise = null;
  }

  private clearAddressTimeout(): void {
    if (this.addressTimeout) clearTimeout(this.addressTimeout);
    this.addressTimeout = null;
  }
}
