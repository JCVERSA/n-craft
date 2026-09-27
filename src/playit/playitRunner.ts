import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '../preflight.ts';
import type { PlayitSetupPhase, PlayitSetupSnapshot } from '../types/backend.ts';
import type { StateStore } from '../state.ts';
import { PlayitIpcClient } from './playitIpc.ts';

const ASSIGNED_ADDRESS = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:joinmc\.link|ply\.gg|playit\.gg)(?::\d{1,5})?)\b/i;
const CLAIM_URL = /https:\/\/playit\.gg\/claim\/[a-f0-9]{6,64}\b/i;
const DEFAULT_SERVICE_SOCKETS = ['/run/playit/playitd.sock', '/var/run/playit/playitd.sock'];

export interface PlayitRunnerOptions {
  cliCommand?: string;
  dataDirectory?: string;
}

interface ConnectedDaemon {
  client: PlayitIpcClient;
  snapshot: Record<string, unknown>;
}

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

function socketPathFromArgs(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--socket-path' && args[index + 1]) return args[index + 1] ?? null;
    if (arg.startsWith('--socket-path=')) return arg.slice('--socket-path='.length);
  }
  return null;
}

/** Runs or attaches to one Playit 1.x daemon and exposes its claim URL to the authenticated panel. */
export class PlayitRunner {
  private startedOnce = false;
  private shuttingDown = false;
  private child: ChildProcess | null = null;
  private setupChild: ChildProcess | null = null;
  private ipcClient: PlayitIpcClient | null = null;
  private startupPromise: Promise<void> | null = null;
  private monitorPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private runtimeDirectory: string | null = null;
  private temporarySecretFilePath: string | null = null;
  private activeSecretPath: string | null = null;
  private daemonSocketPath: string | null = null;
  private addressTimeout: NodeJS.Timeout | null = null;
  private setupOutputTail = '';
  private detectedAddressThisRun = false;
  private fatalLifecycleError: string | null = null;
  private setupStarted = false;
  private setupPhase: PlayitSetupPhase = 'starting';
  private claimUrl: string | null = null;
  private setupError: string | null = null;
  private hasSecret = false;
  private ownsDaemon = false;
  private readonly closedChildren = new WeakSet<ChildProcess>();
  private readonly closedSetupChildren = new WeakSet<ChildProcess>();
  private readonly startupController = new AbortController();
  private readonly setupController = new AbortController();
  private readonly addressTimeoutMs = readTimeout('PLAYIT_ADDRESS_TIMEOUT_MS', 25_000);
  private readonly startupTimeoutMs = readTimeout('PLAYIT_START_TIMEOUT_MS', 20_000);
  private readonly daemonCommand: string;
  private readonly cliCommand: string;
  private readonly dataDirectory: string;

  constructor(
    daemonCommand: string,
    private readonly legacySecretKey: string | undefined,
    private readonly state: StateStore,
    options: PlayitRunnerOptions = {},
  ) {
    this.daemonCommand = daemonCommand;
    this.cliCommand = options.cliCommand?.trim() || process.env.PLAYIT_CLI_BIN?.trim() || 'playit';
    this.dataDirectory = path.resolve(options.dataDirectory?.trim() || 'data');
  }

  getSetupSnapshot(): PlayitSetupSnapshot {
    return {
      phase: this.setupPhase,
      claimUrl: this.claimUrl,
      error: this.setupError,
    };
  }

  startOnce(): void {
    if (this.startedOnce || this.shuttingDown) return;
    this.startedOnce = true;
    this.detectedAddressThisRun = false;
    this.fatalLifecycleError = null;
    this.setupPhase = 'starting';
    this.claimUrl = null;
    this.setupError = null;

    this.startupPromise = this.initializeDaemon().catch(async (error) => {
      if (this.shuttingDown) return;
      const message = (error as Error).message || 'Échec du démarrage de Playit.';
      console.error(`[playit] ${message}`);
      await this.stopOwnedDaemon().catch((stopError) => console.error(`[playit] ${String(stopError)}`));
      this.ipcClient?.close();
      this.ipcClient = null;
      this.setupPhase = 'failed';
      this.setupError = message;
      await this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: message,
        startedAt: null,
      }).catch((persistError) => console.error(`[playit] ${String(persistError)}`));
    });
  }

  requestSetup(): void {
    if (this.shuttingDown) throw new Error('Le panneau est en cours d’arrêt.');
    if (this.setupChild && this.setupChild.exitCode === null && this.setupChild.signalCode === null) return;
    if (!this.daemonSocketPath || !this.ipcClient) throw new Error('Le daemon Playit n’est pas encore prêt. Réessaie dans quelques secondes.');
    if (this.hasSecret) throw new Error('L’agent Playit est déjà configuré. Crée ou vérifie son tunnel dans ton compte Playit.');

    const executable = resolveExecutable(this.cliCommand);
    if (!executable) {
      this.setupPhase = 'failed';
      this.setupError = `CLI Playit introuvable : ${this.cliCommand}. Installe le CLI officiel pour afficher le lien de claim.`;
      void this.state.updatePlayit({
        status: 'configuration_missing',
        address: null,
        addressDetectedAt: null,
        error: this.setupError,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      throw new Error(this.setupError);
    }

    this.setupStarted = true;
    this.setupPhase = 'waiting_for_secret';
    this.claimUrl = null;
    this.setupError = null;
    this.setupOutputTail = '';
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
    delete childEnvironment.PANEL_TOKEN;
    delete childEnvironment.PLAYIT_SECRET_KEY;

    let child: ChildProcess;
    try {
      child = spawn(executable, [
        '--socket-path', this.daemonSocketPath,
        '--stdout',
        'setup',
      ], {
        cwd: this.dataDirectory,
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      this.setupPhase = 'failed';
      this.setupError = `Impossible de lancer le CLI Playit : ${(error as Error).message}`;
      throw new Error(this.setupError);
    }
    this.setupChild = child;
    child.stdout?.on('data', (chunk: Buffer) => this.consumeSetupOutput(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.consumeSetupOutput(chunk));
    child.once('error', (error) => {
      this.setupError = `Impossible de lancer le CLI Playit : ${error.message}`;
      this.setupPhase = 'failed';
      if (this.setupChild === child) this.setupChild = null;
    });
    child.once('close', (code, signal) => {
      this.closedSetupChildren.add(child);
      if (this.setupChild === child) this.setupChild = null;
      if (this.shuttingDown || this.setupController.signal.aborted) return;
      if (code === 0 && this.hasSecret) {
        this.setupPhase = 'configured';
        this.claimUrl = null;
        this.setupError = null;
        return;
      }
      if (!this.hasSecret) {
        this.setupPhase = 'failed';
        this.setupError = signal
          ? `Le setup Playit s’est arrêté (signal ${signal}). Tu peux réessayer depuis le dashboard.`
          : `Le setup Playit s’est terminé avec le code ${code ?? 'inconnu'}. Vérifie la connexion à api.playit.gg puis réessaie.`;
        this.claimUrl = null;
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.clearAddressTimeout();
    this.startupController.abort(new Error('Arrêt du panneau : Playit annulé.'));
    this.setupController.abort(new Error('Arrêt du panneau : setup Playit annulé.'));
    this.ipcClient?.close();
    this.ipcClient = null;

    this.shutdownPromise = (async () => {
      await this.startupPromise?.catch(() => undefined);
      await this.monitorPromise?.catch(() => undefined);
      await this.stopSetupChild();
      await this.stopOwnedDaemon();
      if (this.runtimeDirectory) {
        const directory = this.runtimeDirectory;
        this.runtimeDirectory = null;
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch((error) => {
          console.error(`[playit] Could not remove runtime directory: ${(error as Error).message}`);
        });
      }
    })();
    return this.shutdownPromise;
  }

  private async initializeDaemon(): Promise<void> {
    const executable = resolveExecutable(this.daemonCommand);
    if (!executable) {
      throw new Error(`Daemon Playit introuvable : ${this.daemonCommand}. Installe le daemon officiel playitd.`);
    }

    const signal = this.startupController.signal;
    const existingConnection = await this.findExistingDaemon(signal);
    if (existingConnection) {
      this.setupError = null;
      this.setupPhase = 'starting';
      this.daemonSocketPath = existingConnection.socketPath;
      this.ownsDaemon = false;
      await this.attachToDaemon(existingConnection.client, existingConnection.snapshot, signal);
      return;
    }

    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-playit-'));
    this.runtimeDirectory = runtimeDirectory;
    await chmod(runtimeDirectory, 0o700);

    const playitDirectory = path.join(this.dataDirectory, 'playit');
    await mkdir(playitDirectory, { recursive: true, mode: 0o700 });
    await chmod(playitDirectory, 0o700);
    const configuredSecretPath = process.env.PLAYIT_SECRET_PATH?.trim();
    const appSecretPath = configuredSecretPath
      ? path.resolve(configuredSecretPath)
      : await this.findPersistentSecretPath(playitDirectory);

    const legacySecret = this.legacySecretKey?.trim();
    let secretPath = appSecretPath;
    if (legacySecret) {
      if (!/^(?:[0-9a-f]{2})+$/i.test(legacySecret)) {
        throw new Error('La variable historique PLAYIT_SECRET_KEY n’a pas le format hexadécimal attendu. Retire-la puis utilise le claim du dashboard.');
      }
      const legacyDirectory = path.join(runtimeDirectory, 'legacy');
      await mkdir(legacyDirectory, { mode: 0o700 });
      await chmod(legacyDirectory, 0o700);
      secretPath = path.join(legacyDirectory, 'secret.key');
      this.temporarySecretFilePath = secretPath;
      await writeFile(secretPath, legacySecret, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    this.activeSecretPath = secretPath;

    const socketPath = path.join(runtimeDirectory, 'playitd.sock');
    this.daemonSocketPath = socketPath;
    this.ownsDaemon = true;
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
    delete childEnvironment.PANEL_TOKEN;
    delete childEnvironment.PLAYIT_SECRET_KEY;

    let spawnError: Error | null = null;
    let child: ChildProcess;
    try {
      child = spawn(executable, [
        '--secret-path', secretPath,
        '--socket-path', socketPath,
        '--platform-docker',
      ], {
        cwd: runtimeDirectory,
        env: childEnvironment,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      this.ownsDaemon = false;
      throw new Error(`Impossible de lancer playitd : ${(error as Error).message}`);
    }
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
      if (!this.shuttingDown && !spawnError) {
        const reason = processSignal ? `signal ${processSignal}` : `code ${code ?? 'inconnu'}`;
        const error = `L’agent Playit s’est arrêté (${reason}). Il ne sera pas relancé automatiquement.`;
        this.setupPhase = 'failed';
        this.setupError = error;
        void this.state.updatePlayit({
          status: 'exited',
          address: null,
          addressDetectedAt: null,
          error,
        }).catch((persistError) => console.error(`[playit] ${String(persistError)}`));
      }
      if (!this.shuttingDown && !signal.aborted) {
        this.startupController.abort(new Error('Le processus playitd s’est arrêté avant de terminer sa connexion IPC.'));
      }
    });

    const connection = await this.connectToDaemon(socketPath, signal);
    this.ownsDaemon = true;
    await this.attachToDaemon(connection.client, connection.snapshot, signal);
  }

  private async findPersistentSecretPath(playitDirectory: string): Promise<string> {
    const appSecret = path.join(playitDirectory, 'secret.toml');
    if (await this.pathExists(appSecret)) return appSecret;

    // Reuse the official CLI's default secret if it was configured manually before the panel install.
    const manualSecret = path.join(os.homedir(), '.local', 'share', 'playit', 'secret.toml');
    if (await this.pathExists(manualSecret)) return manualSecret;
    return appSecret;
  }

  private async findExistingDaemon(signal: AbortSignal): Promise<{ socketPath: string; client: PlayitIpcClient; snapshot: Record<string, unknown> } | null> {
    const candidates: string[] = [];
    const configuredSocket = process.env.PLAYIT_SOCKET_PATH?.trim();
    if (configuredSocket) candidates.push(path.resolve(configuredSocket));
    candidates.push(...DEFAULT_SERVICE_SOCKETS);
    if (process.platform === 'linux') candidates.push(...await this.findSocketPathsFromProc());

    const seen = new Set<string>();
    for (const socketPath of candidates) {
      if (!socketPath || seen.has(socketPath)) continue;
      seen.add(socketPath);
      if (signal.aborted) throw abortError(signal);
      const connected = await this.tryConnect(socketPath, signal, 750);
      if (connected) return { socketPath, ...connected };
    }
    return null;
  }

  private async findSocketPathsFromProc(): Promise<string[]> {
    const paths: string[] = [];
    const processes = await readdir('/proc').catch(() => []);
    for (const entry of processes) {
      if (!/^\d+$/.test(entry)) continue;
      const processDirectory = `/proc/${entry}`;
      const args = (await readFile(path.join(processDirectory, 'cmdline')).catch(() => Buffer.alloc(0)))
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      const executable = path.basename(args[0] ?? '');
      if (!/^(?:playitd|playit-linux-amd64)$/i.test(executable)) continue;
      const socketPath = socketPathFromArgs(args.slice(1));
      if (socketPath && path.isAbsolute(socketPath)) paths.push(socketPath);
    }
    return paths;
  }

  private async tryConnect(socketPath: string, signal: AbortSignal, timeoutMs: number): Promise<ConnectedDaemon | null> {
    let client: PlayitIpcClient | null = null;
    try {
      client = await PlayitIpcClient.connect(socketPath, signal, timeoutMs);
      const subscription = await client.subscribe(signal, timeoutMs);
      const wrapper = isRecord(subscription) ? subscription : {};
      const snapshot = isRecord(wrapper.snapshot) ? wrapper.snapshot : {};
      return { client, snapshot };
    } catch {
      client?.close();
      if (signal.aborted) throw abortError(signal);
      return null;
    }
  }

  private async connectToDaemon(socketPath: string, signal: AbortSignal): Promise<ConnectedDaemon> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: Error = new Error('Le socket IPC Playit n’est pas disponible.');
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError(signal);
      try {
        const connected = await this.tryConnect(socketPath, signal, Math.min(1000, deadline - Date.now()));
        if (connected) return connected;
        lastError = new Error('Le daemon ne répond pas encore à IPC v2.');
      } catch (error) {
        lastError = error as Error;
        if (signal.aborted) throw abortError(signal);
      }
      await delay(100, signal);
    }
    throw new Error(`Le socket IPC de playitd n’est pas devenu disponible (${lastError.message}).`);
  }

  private async attachToDaemon(client: PlayitIpcClient, snapshot: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    this.ipcClient = client;
    client.on('lifecycle', (lifecycle: unknown) => this.applyLifecycle(lifecycle));
    this.applyLifecycle(snapshot.lifecycle);
    this.hasSecret = isRecord(snapshot.status) && snapshot.status.has_secret === true;
    if (!this.activeSecretPath) {
      const playitDirectory = path.join(this.dataDirectory, 'playit');
      const configuredSecretPath = process.env.PLAYIT_SECRET_PATH?.trim();
      this.activeSecretPath = configuredSecretPath
        ? path.resolve(configuredSecretPath)
        : await this.findPersistentSecretPath(playitDirectory);
    }

    if (this.hasSecret) {
      this.setupPhase = 'configured';
      this.claimUrl = null;
      this.setupError = null;
    } else {
      this.setupPhase = 'waiting_for_secret';
      this.claimUrl = null;
      this.setupError = null;
      await this.state.updatePlayit({
        status: 'waiting_for_secret',
        address: null,
        addressDetectedAt: null,
        error: null,
        startedAt: new Date().toISOString(),
      });
    }

    if (this.hasSecret) {
      if (this.activeSecretPath) await chmod(this.activeSecretPath, 0o600).catch(() => undefined);
      await this.removeLegacySecretFile();
    }

    if (signal.aborted) throw abortError(signal);
    if (this.fatalLifecycleError) throw new Error(this.fatalLifecycleError);

    if (!this.detectedAddressThisRun && this.hasSecret) {
      this.addressTimeout = setTimeout(() => {
        if (!this.child && !this.ipcClient) return;
        if (this.state.getSnapshot().playit.address) return;
        void this.state.updatePlayit({
          status: 'address_not_detected',
          address: null,
          addressDetectedAt: null,
          error: 'Agent Playit connecté, mais aucun tunnel avec adresse publique n’a été détecté. Configure un tunnel Minecraft Bedrock UDP sur le port 19132 dans Playit.',
        }).catch((error) => console.error(`[playit] ${String(error)}`));
      }, this.addressTimeoutMs);
    }

    if (!this.hasSecret) {
      try {
        this.requestSetup();
      } catch {
        // Keep the daemon waiting for a secret so a later dashboard retry can continue setup.
      }
    }
    this.monitorPromise = client.monitor(signal).catch(async (error) => {
      if (this.shuttingDown || signal.aborted) return;
      this.clearAddressTimeout();
      const message = `Connexion IPC Playit perdue (${(error as Error).message}).`;
      this.setupPhase = 'failed';
      this.setupError = message;
      await this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: message,
      }).catch((persistError) => console.error(`[playit] ${String(persistError)}`));
      if (this.ownsDaemon) await this.stopOwnedDaemon().catch((stopError) => console.error(`[playit] ${String(stopError)}`));
    });
  }

  private applyLifecycle(value: unknown): void {
    if (!isRecord(value) || typeof value.state !== 'string') return;
    const lifecycle = value.state;

    if (lifecycle === 'running') {
      this.hasSecret = true;
      void this.removeLegacySecretFile();
      if (this.activeSecretPath) void chmod(this.activeSecretPath, 0o600).catch(() => undefined);
      this.setupPhase = 'configured';
      this.claimUrl = null;
      this.setupError = null;
      this.clearAddressTimeout();
      const data = isRecord(value.data) ? value.data : {};
      const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
      for (const tunnel of tunnels) {
        if (!isRecord(tunnel) || tunnel.is_disabled === true || typeof tunnel.display_address !== 'string') continue;
        const match = tunnel.display_address.match(ASSIGNED_ADDRESS);
        if (!match?.[1]) continue;
        this.detectedAddressThisRun = true;
        void this.state.updatePlayit({
          status: 'running',
          address: match[1],
          addressDetectedAt: new Date().toISOString(),
          error: null,
        }).catch((error) => console.error(`[playit] ${String(error)}`));
        return;
      }
      void this.state.updatePlayit({
        status: 'address_not_detected',
        address: null,
        addressDetectedAt: null,
        error: 'Agent Playit connecté, mais aucun tunnel avec adresse publique n’a été détecté. Configure un tunnel Minecraft Bedrock UDP sur le port 19132 dans Playit.',
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      return;
    }

    if (lifecycle === 'waiting_for_secret') {
      this.hasSecret = false;
      this.setupPhase = this.claimUrl ? 'claim_pending' : 'waiting_for_secret';
      void this.state.updatePlayit({
        status: this.claimUrl ? 'claim_pending' : 'waiting_for_secret',
        address: null,
        addressDetectedAt: null,
        error: null,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      return;
    }

    if (lifecycle === 'starting') {
      void this.state.updatePlayit({
        status: 'starting',
        address: null,
        addressDetectedAt: null,
        error: null,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      return;
    }

    if (lifecycle === 'has_invalid_secret' || lifecycle === 'disabled_over_limit' || lifecycle === 'error') {
      const detail = isRecord(value.data) && typeof value.data.message === 'string'
        ? value.data.message
        : 'playitd a signalé un état d’erreur.';
      this.fatalLifecycleError = detail;
      this.setupPhase = 'failed';
      this.setupError = detail;
      this.clearAddressTimeout();
      void this.state.updatePlayit({
        status: 'failed',
        address: null,
        addressDetectedAt: null,
        error: detail,
      }).catch((error) => console.error(`[playit] ${String(error)}`));
      const setup = this.setupChild;
      if (setup && setup.exitCode === null && setup.signalCode === null) setup.kill('SIGTERM');
    }
  }

  private consumeSetupOutput(chunk: Buffer): void {
    this.setupOutputTail = `${this.setupOutputTail}${chunk.toString('utf8')}`.slice(-8192);
    const match = this.setupOutputTail.match(CLAIM_URL);
    if (!match?.[0]) return;
    const nextUrl = match[0];
    if (this.claimUrl === nextUrl) return;
    this.claimUrl = nextUrl;
    this.setupPhase = 'claim_pending';
    this.setupError = null;
    void this.state.updatePlayit({
      status: 'claim_pending',
      address: null,
      addressDetectedAt: null,
      error: null,
    }).catch((error) => console.error(`[playit] ${String(error)}`));
  }

  private async removeLegacySecretFile(): Promise<void> {
    const secretPath = this.temporarySecretFilePath;
    if (!secretPath) return;
    try {
      await rm(secretPath, { force: true });
      if (this.temporarySecretFilePath === secretPath) this.temporarySecretFilePath = null;
    } catch (error) {
      console.error(`[playit] Could not remove temporary legacy secret file: ${(error as Error).message}`);
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async stopSetupChild(): Promise<void> {
    const child = this.setupChild;
    if (!child || this.closedSetupChildren.has(child)) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // The CLI may have exited between the state check and the signal.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 2500);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async stopOwnedDaemon(): Promise<void> {
    if (!this.ownsDaemon) return;
    const child = this.child;
    if (!child || this.closedChildren.has(child)) {
      this.ownsDaemon = false;
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.ownsDaemon = false;
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // The daemon may have exited between the state check and the signal.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.ownsDaemon = false;
  }

  private clearAddressTimeout(): void {
    if (this.addressTimeout) clearTimeout(this.addressTimeout);
    this.addressTimeout = null;
  }
}
