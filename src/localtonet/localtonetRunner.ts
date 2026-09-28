import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '../preflight.ts';
import type { LocaltonetLifecycle } from '../types/backend.ts';
import type { StateStore } from '../state.ts';
import { buildChildEnvironment } from '../childEnvironment.ts';
import { fetchBedrockTunnel } from './localtonetApi.ts';

export interface LocaltonetRunnerOptions {
  binaryCommand?: string;
  dataDirectory?: string;
  apiBaseUrl?: string;
  pollIntervalMs?: number;
  apiTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function readInterval(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 5_000 ? value as number : fallback;
}

function privateError(error: unknown): string {
  return error instanceof Error ? error.message : 'Erreur inconnue Localtonet.';
}

/** Owns one headless Localtonet client and discovers its public UDP endpoint through API v2. */
export class LocaltonetRunner {
  private startedOnce = false;
  private shuttingDown = false;
  private child: ChildProcess | null = null;
  private runtimeDirectory: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private startedAt: string | null = null;
  private readonly binaryCommand: string;
  private readonly dataDirectory: string;
  private readonly apiBaseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly apiTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly authToken: string;
  private readonly apiKey: string;
  private status: LocaltonetLifecycle = 'starting';
  private error: string | null = null;
  private address: string | null = null;
  private addressDetectedAt: string | null = null;

  constructor(
    private readonly state: StateStore,
    options: LocaltonetRunnerOptions = {},
  ) {
    this.binaryCommand = options.binaryCommand?.trim() || process.env.LOCALTONET_BIN?.trim() || 'localtonet';
    this.dataDirectory = path.resolve(options.dataDirectory?.trim() || process.env.DATA_DIR?.trim() || 'data');
    this.apiBaseUrl = options.apiBaseUrl?.trim() || process.env.LOCALTONET_API_BASE_URL?.trim() || 'https://localtonet.com';
    this.pollIntervalMs = readInterval(options.pollIntervalMs ?? Number(process.env.LOCALTONET_API_POLL_INTERVAL_MS), 30_000);
    this.apiTimeoutMs = readInterval(options.apiTimeoutMs ?? Number(process.env.LOCALTONET_API_TIMEOUT_MS), 8_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authToken = process.env.LOCALTONET_AUTH_TOKEN?.trim() ?? '';
    this.apiKey = process.env.LOCALTONET_API_KEY?.trim() ?? '';
  }

  getSetupSnapshot(): { status: LocaltonetLifecycle; error: string | null } {
    return { status: this.status, error: this.error };
  }

  startOnce(): void {
    if (this.startedOnce || this.shuttingDown) return;
    this.startedOnce = true;
    this.startedAt = null;
    this.address = null;
    this.addressDetectedAt = null;
    this.setStatus('starting', 'Préparation du client Localtonet…', null);
    void this.initialize();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    await this.stopChild();
    if (this.runtimeDirectory) {
      const directory = this.runtimeDirectory;
      this.runtimeDirectory = null;
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch((error) => {
        console.error(`[localtonet] Could not remove private runtime directory: ${(error as Error).message}`);
      });
    }
  }

  private async initialize(): Promise<void> {
    if (!this.authToken || !this.apiKey) {
      const missing = [
        !this.authToken ? 'LOCALTONET_AUTH_TOKEN' : null,
        !this.apiKey ? 'LOCALTONET_API_KEY' : null,
      ].filter((value): value is string => value !== null);
      this.setStatus('configuration_missing', `Variables manquantes dans .env : ${missing.join(', ')}.`, null);
      return;
    }

    const executable = resolveExecutable(this.binaryCommand);
    if (!executable) {
      this.setStatus('configuration_missing', `Client Localtonet introuvable : ${this.binaryCommand}. Installe le client Linux officiel puis redémarre le panneau.`, null);
      return;
    }

    try {
      this.runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-localtonet-'));
      if (this.shuttingDown) {
        await this.removeRuntimeDirectory();
        return;
      }
      await chmod(this.runtimeDirectory, 0o700);
      const tokenFile = path.join(this.runtimeDirectory, 'auth-token');
      await writeFile(tokenFile, `${this.authToken}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(tokenFile, 0o600);
      if (this.shuttingDown) {
        await this.removeRuntimeDirectory();
        return;
      }

      const childEnvironment = buildChildEnvironment();
      let child: ChildProcess;
      try {
        child = spawn(executable, ['--headless', '--authtoken-file', tokenFile], {
          cwd: this.dataDirectory,
          env: childEnvironment,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        throw new Error(`Impossible de lancer le client Localtonet : ${(error as Error).message}`);
      }
      this.child = child;
      this.startedAt = new Date().toISOString();
      this.setStatus('starting', 'Démarrage du client Localtonet…', null);
      let startupError = false;

      child.once('error', (error) => {
        startupError = true;
        if (this.shuttingDown) return;
        this.setStatus('failed', `Impossible de lancer le client Localtonet : ${error.message}`, null);
        void this.removeRuntimeDirectory();
      });
      child.once('spawn', () => {
        if (!this.shuttingDown) void this.refreshTunnel();
      });
      child.once('close', (code, signal) => {
        if (this.shuttingDown || startupError) return;
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'inconnu'}`;
        this.setStatus('exited', `Le client Localtonet s’est arrêté (${detail}). Vérifie sa version et ses options --headless/--authtoken-file.`, this.address);
        void this.removeRuntimeDirectory();
      });
    } catch (error) {
      this.setStatus('failed', privateError(error), null);
      await this.removeRuntimeDirectory();
      return;
    }
  }

  private async refreshTunnel(): Promise<void> {
    if (this.shuttingDown || this.polling || !this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.polling = true;
    try {
      const tunnel = await fetchBedrockTunnel({
        apiBaseUrl: this.apiBaseUrl,
        apiKey: this.apiKey,
        authToken: this.authToken,
        timeoutMs: this.apiTimeoutMs,
        fetchImpl: this.fetchImpl,
      });
      if (!tunnel) {
        this.setStatus(
          'address_not_detected',
          'Aucun tunnel UDP actif vers le port local 19132 n’a été trouvé. Crée ou démarre ce tunnel dans le dashboard Localtonet.',
          null,
        );
      } else {
        const now = new Date().toISOString();
        this.address = tunnel.address;
        this.addressDetectedAt ??= now;
        this.setStatus(
          tunnel.connected ? 'running' : 'starting',
          tunnel.connected ? null : 'Tunnel trouvé, mais Localtonet ne le signale pas encore connecté.',
          tunnel.address,
        );
      }
    } catch (error) {
      this.setStatus('failed', privateError(error), this.address);
      console.error(`[localtonet] ${privateError(error)}`);
    } finally {
      this.polling = false;
      if (!this.shuttingDown && this.child && this.child.exitCode === null && this.child.signalCode === null) {
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          void this.refreshTunnel();
        }, this.pollIntervalMs);
      }
    }
  }

  private setStatus(status: LocaltonetLifecycle, error: string | null, address: string | null): void {
    this.status = status;
    this.error = error;
    this.address = address;
    void this.state.updateLocaltonet({
      status,
      address,
      error,
      startedAt: this.startedAt,
      addressDetectedAt: address ? this.addressDetectedAt : null,
    }).catch((persistError) => console.error(`[localtonet] Could not persist tunnel status: ${(persistError as Error).message}`));
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // The client may have exited between the state check and the signal.
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

  private async removeRuntimeDirectory(): Promise<void> {
    if (!this.runtimeDirectory) return;
    const directory = this.runtimeDirectory;
    this.runtimeDirectory = null;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch((error) => {
      console.error(`[localtonet] Could not remove private runtime directory: ${(error as Error).message}`);
    });
  }
}
