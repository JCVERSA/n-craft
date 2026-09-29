import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BedrockConsole } from './console.ts';
import type { DeployPipeline } from './deployPipeline.ts';
import type { StateStore } from '../state.ts';
import type { RecoverySettings, RecoverySnapshot } from '../types/backend.ts';

const RECOVERY_SCHEMA = 1;
const STABLE_WINDOW_MS = 10 * 60_000;
const ATTEMPT_TIMEOUT_MS = 5 * 60_000;

interface RecoveryIndex {
  schemaVersion: number;
  settings: RecoverySettings;
  attempts: number;
  lastError: string | null;
}

function normalizeSettings(value: unknown): RecoverySettings {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const delaySeconds = Number(record.delaySeconds ?? 10);
  const maxAttempts = Number(record.maxAttempts ?? 5);
  return {
    restartAfterCrash: record.restartAfterCrash !== false,
    startAfterPanelRestart: record.startAfterPanelRestart === true,
    maxAttempts: Number.isInteger(maxAttempts) ? Math.max(1, Math.min(10, maxAttempts)) : 5,
    delaySeconds: Number.isInteger(delaySeconds) ? Math.max(1, Math.min(3600, delaySeconds)) : 10,
  };
}

export class BedrockRecoveryManager {
  private readonly filePath: string;
  private settings: RecoverySettings = normalizeSettings(null);
  private attempts = 0;
  private phase: RecoverySnapshot['phase'] = 'idle';
  private nextAttemptAt: string | null = null;
  private lastError: string | null = null;
  private startupPending = false;
  private timer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private activeAttempt: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(
    dataDirectory: string,
    private readonly state: StateStore,
    private readonly bedrockConsole: BedrockConsole,
    private readonly pipeline: DeployPipeline,
  ) {
    this.filePath = path.join(dataDirectory, 'recovery.json');
    this.bedrockConsole.on('exit', this.handleProcessExit);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('format invalide');
      const value = parsed as Record<string, unknown>;
      if (value.schemaVersion !== RECOVERY_SCHEMA) throw new Error('version de schéma non prise en charge');
      this.settings = normalizeSettings(value.settings);
      this.attempts = Number.isInteger(value.attempts) ? Math.max(0, Math.min(10, Number(value.attempts))) : 0;
      this.lastError = typeof value.lastError === 'string' ? value.lastError.slice(0, 1000) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Le fichier de reprise automatique est illisible : ${(error as Error).message}`);
      }
    }
    this.startupPending = this.state.shouldStartAfterPanelRestart() && this.settings.startAfterPanelRestart;
    await this.persist();
  }

  start(): void {
    if (this.shuttingDown || !this.startupPending) return;
    this.startupPending = false;
    if (!this.state.getSnapshot().activeConfig) {
      this.phase = 'exhausted';
      this.lastError = 'Reprise au démarrage ignorée : aucun déploiement Bedrock valide n’est enregistré.';
      void this.persist().catch(() => undefined);
      return;
    }
    if (this.attempts >= this.settings.maxAttempts) {
      this.phase = 'exhausted';
      this.lastError = 'La limite de reprises automatiques a été atteinte avant le redémarrage du panneau.';
      void this.persist().catch(() => undefined);
      return;
    }
    this.scheduleAttempt('Démarrage automatique après redémarrage du panneau.');
  }

  getSnapshot(): RecoverySnapshot {
    return {
      settings: { ...this.settings },
      phase: this.phase,
      attempts: this.attempts,
      nextAttemptAt: this.nextAttemptAt,
      lastError: this.lastError,
      startupPending: this.startupPending,
    };
  }

  async updateSettings(input: unknown): Promise<RecoverySnapshot> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Réglages de reprise invalides.');
    const value = input as Record<string, unknown>;
    if (typeof value.restartAfterCrash !== 'boolean' || typeof value.startAfterPanelRestart !== 'boolean') {
      throw new Error('Les options de reprise doivent être booléennes.');
    }
    const maxAttempts = Number(value.maxAttempts);
    const delaySeconds = Number(value.delaySeconds);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new Error('La limite de reprises doit être un entier de 1 à 10.');
    }
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 3600) {
      throw new Error('Le délai initial doit être compris entre 1 et 3 600 secondes.');
    }
    const previousSettings = this.settings;
    this.settings = {
      restartAfterCrash: value.restartAfterCrash,
      startAfterPanelRestart: value.startAfterPanelRestart,
      maxAttempts,
      delaySeconds,
    };
    try {
      await this.persist();
    } catch (error) {
      this.settings = previousSettings;
      throw error;
    }
    if (!this.settings.restartAfterCrash && !this.startupPending) this.cancelWaitingAttempt();
    return this.getSnapshot();
  }

  async prepareManualStart(): Promise<void> {
    this.cancelWaitingAttempt();
    this.startupPending = false;
    this.attempts = 0;
    this.phase = 'idle';
    this.lastError = null;
    await this.state.updateServer({ desiredRunning: true });
    await this.persist();
  }

  async prepareManualStop(): Promise<void> {
    this.cancelWaitingAttempt();
    this.startupPending = false;
    this.attempts = 0;
    this.phase = 'idle';
    this.lastError = null;
    await this.state.updateServer({ desiredRunning: false });
    await this.persist();
  }

  async markDesiredRunning(): Promise<void> {
    await this.state.updateServer({ desiredRunning: true });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.bedrockConsole.removeListener('exit', this.handleProcessExit);
    this.cancelWaitingAttempt();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    await this.activeAttempt?.catch(() => undefined);
    await this.persist();
  }

  private readonly handleProcessExit = (event: { wasReady: boolean; intentional?: boolean }) => {
    if (this.shuttingDown || event.intentional || !event.wasReady) return;
    const server = this.state.getSnapshot().server;
    if (!server.desiredRunning || !this.settings.restartAfterCrash) return;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (this.attempts >= this.settings.maxAttempts) {
      this.phase = 'exhausted';
      this.lastError = 'Reprise automatique arrêtée : limite de tentatives atteinte pour protéger le serveur contre une boucle de crash.';
      void this.persist().catch(() => undefined);
      return;
    }
    this.scheduleAttempt('Arrêt inattendu de Bedrock détecté.');
  };

  private scheduleAttempt(reason: string): void {
    if (this.shuttingDown || this.timer || this.activeAttempt) return;
    if (this.attempts >= this.settings.maxAttempts) {
      this.phase = 'exhausted';
      this.lastError = `${reason} Limite de reprises automatiques atteinte.`;
      void this.persist().catch(() => undefined);
      return;
    }
    const delaySeconds = Math.min(300, this.settings.delaySeconds * (2 ** this.attempts));
    const due = Date.now() + delaySeconds * 1000;
    this.nextAttemptAt = new Date(due).toISOString();
    this.phase = 'waiting';
    this.lastError = reason;
    void this.persist().catch(() => undefined);
    this.timer = setTimeout(() => {
      this.timer = null;
      const operation = this.performAttempt();
      this.activeAttempt = operation;
      void operation.catch((error) => {
        console.error(`[recovery] Unhandled recovery error: ${(error as Error).message}`);
      }).finally(() => {
        if (this.activeAttempt === operation) this.activeAttempt = null;
      });
    }, delaySeconds * 1000);
    this.timer.unref?.();
  }

  private async performAttempt(): Promise<void> {
    if (this.shuttingDown || !this.state.getSnapshot().server.desiredRunning) {
      this.phase = 'idle';
      this.nextAttemptAt = null;
      await this.persist();
      return;
    }
    if (this.attempts >= this.settings.maxAttempts) {
      this.phase = 'exhausted';
      this.lastError = 'Limite de reprises automatiques atteinte.';
      await this.persist();
      return;
    }

    this.attempts += 1;
    this.phase = 'starting';
    this.nextAttemptAt = null;
    this.lastError = `Tentative de reprise ${this.attempts}/${this.settings.maxAttempts}.`;
    await this.persist();
    try {
      if (!this.state.getSnapshot().activeConfig) throw new Error('Aucune configuration Bedrock installée.');
      this.pipeline.startExisting();
      await this.waitForAttemptResult();
      this.phase = 'idle';
      this.lastError = null;
      await this.persist();
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.state.getSnapshot().server.status === 'running') {
          this.attempts = 0;
          this.lastError = null;
          void this.persist().catch(() => undefined);
        }
      }, STABLE_WINDOW_MS);
      this.stableTimer.unref?.();
      console.info(`[recovery] Bedrock recovered; attempts will reset after ${Math.round(STABLE_WINDOW_MS / 60_000)} stable minutes.`);
      return;
    } catch (error) {
      this.lastError = (error as Error).message || 'Échec de la tentative de reprise Bedrock.';
      if (this.attempts >= this.settings.maxAttempts) {
        this.phase = 'exhausted';
        this.nextAttemptAt = null;
        this.lastError = `${this.lastError} Reprise automatique arrêtée après ${this.attempts} tentatives.`;
      } else {
        this.phase = 'idle';
      }
      await this.persist();
      console.warn(`[recovery] ${this.lastError}`);
      if (this.phase !== 'exhausted' && this.state.getSnapshot().server.desiredRunning) {
        this.scheduleAttempt('Une nouvelle reprise sera tentée après le délai exponentiel configuré.');
      }
    }
  }

  private waitForAttemptResult(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let poll: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(poll);
        this.state.removeListener('change', onChange);
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onChange = () => {
        if (this.shuttingDown) {
          finish(new Error('Reprise automatique annulée par l’arrêt du panneau.'));
          return;
        }
        const snapshot = this.state.getSnapshot();
        if (snapshot.server.status === 'running' && this.bedrockConsole.isReady) {
          finish();
        } else if (!this.pipeline.isRunning && snapshot.server.status === 'failed' && !this.bedrockConsole.isRunning) {
          finish(new Error(snapshot.server.error || snapshot.pipeline.error || 'Le serveur n’a pas démarré.'));
        }
      };
      const timer = setTimeout(() => finish(new Error('Délai de démarrage Bedrock dépassé pendant la reprise automatique.')), ATTEMPT_TIMEOUT_MS);
      this.state.on('change', onChange);
      poll = setInterval(onChange, 200);
      poll.unref?.();
      onChange();
    });
  }

  private cancelWaitingAttempt(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = null;
    if (this.phase === 'waiting') this.phase = 'idle';
  }

  private persist(): Promise<void> {
    const write = this.persistQueue.then(async () => {
      const index: RecoveryIndex = {
        schemaVersion: RECOVERY_SCHEMA,
        settings: this.settings,
        attempts: this.attempts,
        lastError: this.lastError,
      };
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        console.error(`[recovery] Could not persist settings: ${(error as Error).message}`);
        throw error;
      }
    });
    this.persistQueue = write.catch(() => undefined);
    return write;
  }
}
