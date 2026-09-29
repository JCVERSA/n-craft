import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StateStore } from './state.ts';
import type { SystemInspector } from './preflight.ts';
import type { MonitoringSample, MonitoringSettings, OperationAlert } from './types/backend.ts';

const STORE_SCHEMA = 1;
const MAX_SAMPLES = 720;
const DEFAULT_SETTINGS: MonitoringSettings = {
  lowDiskBytes: 512 * 1024 ** 2,
  highCpuPercent: 90,
  highMemoryBytes: 6 * 1024 ** 3,
};

interface MonitoringStore {
  schemaVersion: number;
  settings: MonitoringSettings;
  samples: MonitoringSample[];
}

export interface MonitoringSnapshot {
  settings: MonitoringSettings;
  samples: MonitoringSample[];
  alerts: OperationAlert[];
}

function normalizeSettings(value: unknown): MonitoringSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
  const record = value as Record<string, unknown>;
  const lowDiskBytes = Number(record.lowDiskBytes ?? DEFAULT_SETTINGS.lowDiskBytes);
  const highCpuPercent = Number(record.highCpuPercent ?? DEFAULT_SETTINGS.highCpuPercent);
  const highMemoryBytes = Number(record.highMemoryBytes ?? DEFAULT_SETTINGS.highMemoryBytes);
  if (!Number.isSafeInteger(lowDiskBytes) || lowDiskBytes < 64 * 1024 ** 2 || lowDiskBytes > 1024 ** 4) {
    throw new Error('Le seuil d’espace disque doit être compris entre 64 Mio et 1 Tio.');
  }
  if (!Number.isFinite(highCpuPercent) || highCpuPercent < 25 || highCpuPercent > 100) {
    throw new Error('Le seuil CPU doit être compris entre 25 et 100 %.');
  }
  if (!Number.isSafeInteger(highMemoryBytes) || highMemoryBytes < 256 * 1024 ** 2 || highMemoryBytes > 1024 ** 4) {
    throw new Error('Le seuil mémoire doit être compris entre 256 Mio et 1 Tio.');
  }
  return { lowDiskBytes, highCpuPercent, highMemoryBytes };
}

function normalizeSamples(value: unknown): MonitoringSample[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_SAMPLES).flatMap((sample): MonitoringSample[] => {
    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) return [];
    const item = sample as Record<string, unknown>;
    if (typeof item.timestamp !== 'string' || Number.isNaN(Date.parse(item.timestamp))) return [];
    const finiteOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return [{
      timestamp: item.timestamp,
      cpuPercent: finiteOrNull(item.cpuPercent),
      memoryBytes: finiteOrNull(item.memoryBytes),
      playersOnline: finiteOrNull(item.playersOnline),
      dataDiskFreeBytes: finiteOrNull(item.dataDiskFreeBytes),
      serverDiskFreeBytes: finiteOrNull(item.serverDiskFreeBytes),
    }];
  });
}

export class MonitoringService {
  private readonly filePath: string;
  private settings = { ...DEFAULT_SETTINGS };
  private samples: MonitoringSample[] = [];
  private alerts: OperationAlert[] = [];
  private alertSince = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private collection: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    dataDirectory: string,
    private readonly state: StateStore,
    private readonly inspector: SystemInspector,
    private readonly intervalMs = 30_000,
  ) {
    this.filePath = path.join(dataDirectory, 'monitoring.json');
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('format invalide');
      const record = parsed as Record<string, unknown>;
      if (record.schemaVersion !== STORE_SCHEMA) throw new Error('version de schéma non prise en charge');
      this.settings = normalizeSettings(record.settings);
      this.samples = normalizeSamples(record.samples);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Les données de métriques et alertes sont illisibles : ${(error as Error).message}`);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    void this.collect();
    this.timer = setInterval(() => { void this.collect(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.collection;
  }

  getSnapshot(sampleLimit = MAX_SAMPLES): MonitoringSnapshot {
    const limit = Number.isInteger(sampleLimit) ? Math.max(0, Math.min(MAX_SAMPLES, sampleLimit)) : MAX_SAMPLES;
    return {
      settings: { ...this.settings },
      samples: (limit === 0 ? [] : this.samples.slice(-limit)).map((sample) => ({ ...sample })),
      alerts: this.alerts.map((alert) => ({ ...alert })),
    };
  }

  async updateSettings(input: unknown): Promise<MonitoringSnapshot> {
    const next = normalizeSettings(input);
    const previous = this.settings;
    this.settings = next;
    this.refreshAlerts();
    try {
      await this.persist();
    } catch (error) {
      this.settings = previous;
      this.refreshAlerts();
      throw error;
    }
    return this.getSnapshot();
  }

  async collect(): Promise<void> {
    if (this.collection) return this.collection;
    const work = this.readSample().finally(() => {
      if (this.collection === work) this.collection = null;
    });
    this.collection = work;
    return work;
  }

  private async readSample(): Promise<void> {
    try {
      const [system, panelState] = await Promise.all([this.inspector.inspect(), Promise.resolve(this.state.getSnapshot())]);
      const server = panelState.server;
      const sample: MonitoringSample = {
        timestamp: new Date().toISOString(),
        cpuPercent: server.status === 'running' ? server.cpuPercent : null,
        memoryBytes: server.status === 'running' ? server.memoryBytes : null,
        playersOnline: server.status === 'running' ? server.playersOnline : null,
        dataDiskFreeBytes: system.dataDiskFreeBytes,
        serverDiskFreeBytes: system.serverDiskFreeBytes,
      };
      const previous = this.samples.at(-1);
      if (previous && Date.parse(previous.timestamp) >= Date.parse(sample.timestamp)) return;
      this.samples = [...this.samples, sample].slice(-MAX_SAMPLES);
      this.refreshAlerts();
      await this.persist();
    } catch (error) {
      console.warn(`[monitoring] Could not collect a metrics sample: ${(error as Error).message}`);
    }
  }

  private refreshAlerts(): void {
    const now = new Date().toISOString();
    const server = this.state.getSnapshot().server;
    const sample = this.samples.at(-1);
    const conditions: Array<{ id: string; severity: OperationAlert['severity']; title: string; detail: string }> = [];
    const diskValues = [sample?.dataDiskFreeBytes, sample?.serverDiskFreeBytes].filter((value): value is number => value !== null && value !== undefined);
    const lowestDisk = diskValues.length ? Math.min(...diskValues) : null;
    if (lowestDisk !== null && lowestDisk < this.settings.lowDiskBytes) {
      conditions.push({
        id: 'low-disk', severity: 'warning', title: 'Espace disque faible',
        detail: `Le volume le plus contraint dispose de ${(lowestDisk / 1024 ** 3).toFixed(2)} Go ; seuil ${(this.settings.lowDiskBytes / 1024 ** 3).toFixed(2)} Go.`,
      });
    }
    if (sample?.cpuPercent !== null && sample?.cpuPercent !== undefined && sample.cpuPercent >= this.settings.highCpuPercent) {
      conditions.push({ id: 'high-cpu', severity: 'warning', title: 'Charge CPU élevée', detail: `BDS utilise ${sample.cpuPercent.toFixed(0)} % du budget CPU.` });
    }
    if (sample?.memoryBytes !== null && sample?.memoryBytes !== undefined && sample.memoryBytes >= this.settings.highMemoryBytes) {
      conditions.push({ id: 'high-memory', severity: 'warning', title: 'Mémoire Bedrock élevée', detail: `BDS utilise ${(sample.memoryBytes / 1024 ** 3).toFixed(2)} Go.` });
    }
    if (server.desiredRunning && server.status === 'failed') {
      conditions.push({ id: 'server-failed', severity: 'error', title: 'Bedrock est en échec', detail: server.error || 'Le serveur s’est arrêté de manière inattendue.' });
    }
    if (this.state.getSnapshot().pipeline.status === 'failed') {
      const detail = this.state.getSnapshot().pipeline.error;
      conditions.push({ id: 'pipeline-failed', severity: 'error', title: 'Opération Bedrock en échec', detail: detail || 'Consulte les journaux de la console.' });
    }
    const nextSince = new Map<string, string>();
    this.alerts = conditions.map((condition) => {
      const since = this.alertSince.get(condition.id) ?? now;
      nextSince.set(condition.id, since);
      return { ...condition, since };
    });
    this.alertSince = nextSince;
  }

  private persist(): Promise<void> {
    const write = this.persistQueue.then(async () => {
      const store: MonitoringStore = { schemaVersion: STORE_SCHEMA, settings: this.settings, samples: this.samples };
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.persistQueue = write.catch((error) => {
      console.warn(`[monitoring] Could not persist metrics: ${(error as Error).message}`);
    });
    return write;
  }
}
