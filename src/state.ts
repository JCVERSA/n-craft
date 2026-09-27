import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DeployConfiguration,
  PersistentPanelState,
  PipelineStep,
  PipelineStatus,
  PlayitLifecycle,
  ServerLifecycle,
} from './types/backend.ts';

function initialState(): PersistentPanelState {
  return {
    schemaVersion: 1,
    pipeline: {
      status: 'idle',
      step: 'idle',
      error: null,
      updatedAt: new Date().toISOString(),
    },
    server: {
      status: 'stopped',
      pid: null,
      startedAt: null,
      error: null,
    },
    playit: {
      status: 'starting',
      address: null,
      error: null,
      startedAt: null,
      addressDetectedAt: null,
    },
    activeConfig: null,
    verification: {
      eula: 'unverified',
      operatorPersistence: 'unverified',
      onlineMode: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeState(value: unknown): PersistentPanelState {
  const base = initialState();
  if (!isRecord(value)) return base;

  const pipeline = isRecord(value.pipeline) ? value.pipeline : {};
  const server = isRecord(value.server) ? value.server : {};
  const playit = isRecord(value.playit) ? value.playit : {};
  const verification = isRecord(value.verification) ? value.verification : {};

  const pipelineStatus: PipelineStatus =
    pipeline.status === 'running' || pipeline.status === 'failed' ? pipeline.status : 'idle';
  const validSteps: PipelineStep[] = [
    'idle', 'preflight', 'stopping', 'wiping', 'downloading', 'extracting',
    'writing_config', 'accepting_eula', 'starting', 'running', 'failed',
  ];
  const serverStatus: ServerLifecycle = [
    'stopped', 'stopping', 'starting', 'running', 'failed',
  ].includes(server.status as ServerLifecycle)
    ? (server.status as ServerLifecycle)
    : 'stopped';
  const playitStatuses: PlayitLifecycle[] = [
    'starting', 'running', 'address_not_detected', 'configuration_missing', 'failed', 'exited',
  ];

  const activeConfig = isRecord(value.activeConfig)
    ? (value.activeConfig as unknown as DeployConfiguration)
    : null;

  return {
    schemaVersion: 1,
    pipeline: {
      status: pipelineStatus,
      step: validSteps.includes(pipeline.step as PipelineStep) ? (pipeline.step as PipelineStep) : 'idle',
      error: typeof pipeline.error === 'string' ? pipeline.error : null,
      updatedAt: typeof pipeline.updatedAt === 'string' ? pipeline.updatedAt : base.pipeline.updatedAt,
    },
    server: {
      status: serverStatus,
      pid: typeof server.pid === 'number' ? server.pid : null,
      startedAt: typeof server.startedAt === 'string' ? server.startedAt : null,
      error: typeof server.error === 'string' ? server.error : null,
    },
    playit: {
      status: playitStatuses.includes(playit.status as PlayitLifecycle)
        ? (playit.status as PlayitLifecycle)
        : 'starting',
      address: typeof playit.address === 'string' ? playit.address : null,
      error: typeof playit.error === 'string' ? playit.error : null,
      startedAt: typeof playit.startedAt === 'string' ? playit.startedAt : null,
      addressDetectedAt: typeof playit.addressDetectedAt === 'string' ? playit.addressDetectedAt : null,
    },
    activeConfig,
    verification: {
      eula: verification.eula === 'prompt_accepted' || verification.eula === 'no_prompt_observed'
        ? verification.eula
        : 'unverified',
      operatorPersistence: 'unverified',
      onlineMode: false,
    },
  };
}

/** JSON-file persistence with serialized, atomic replacements. */
export class StateStore extends EventEmitter {
  readonly filePath: string;
  private state: PersistentPanelState = initialState();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    super();
    this.filePath = path.join(dataDirectory, 'state.json');
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const content = await readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(content) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[state] Could not read state.json; starting with safe defaults: ${(error as Error).message}`);
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        await rename(this.filePath, corruptPath).catch(() => undefined);
        this.state = initialState();
      }
    }

    // A container restart normally kills its children, but a Node-only restart may
    // leave an orphan process. Do not present persisted state as proof of liveness;
    // graceful panel shutdown is responsible for stopping children before exit.
    this.state.server = { status: 'stopped', pid: null, startedAt: null, error: null };
    if (this.state.pipeline.status === 'running') {
      this.state.pipeline = {
        status: 'failed',
        step: this.state.pipeline.step === 'failed' ? 'preflight' : this.state.pipeline.step,
        error: 'Le panneau a redémarré pendant le déploiement ; le serveur enfant a été perdu.',
        updatedAt: new Date().toISOString(),
      };
    }
    await this.persist();
    this.emit('change', this.getSnapshot());
  }

  getSnapshot(): PersistentPanelState {
    return structuredClone(this.state);
  }

  async updatePipeline(patch: Partial<PersistentPanelState['pipeline']>): Promise<void> {
    await this.update(() => {
      this.state.pipeline = {
        ...this.state.pipeline,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async updateServer(patch: Partial<PersistentPanelState['server']>): Promise<void> {
    await this.update(() => {
      this.state.server = { ...this.state.server, ...patch };
    });
  }

  async updatePlayit(patch: Partial<PersistentPanelState['playit']>): Promise<void> {
    await this.update(() => {
      this.state.playit = { ...this.state.playit, ...patch };
    });
  }

  async setActiveConfig(config: DeployConfiguration): Promise<void> {
    await this.update(() => {
      this.state.activeConfig = structuredClone(config);
    });
  }

  async setEulaVerification(value: PersistentPanelState['verification']['eula']): Promise<void> {
    await this.update(() => {
      this.state.verification = { ...this.state.verification, eula: value };
    });
  }

  async resetPipeline(): Promise<void> {
    await this.update(() => {
      this.state.pipeline = {
        status: 'idle',
        step: 'idle',
        error: null,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async update(mutator: () => void): Promise<void> {
    mutator();
    this.emit('change', this.getSnapshot());
    await this.persist();
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const write = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch((error) => {
      console.error(`[state] Failed to persist state.json: ${(error as Error).message}`);
    });
    return write;
  }
}
