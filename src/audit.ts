import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEvent } from './types/backend.ts';
import type { PanelPrincipal } from './auth.ts';

const AUDIT_SCHEMA = 1;
const MAX_EVENTS = 1000;
const VALID_ROLES = new Set(['owner', 'admin', 'operator', 'viewer']);

interface AuditStore {
  schemaVersion: number;
  events: AuditEvent[];
}

export class AuditLog {
  private readonly filePath: string;
  private events: AuditEvent[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, 'audit.json');
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const info = await lstat(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Le journal d’activité n’est pas un fichier ordinaire.');
    const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Le journal d’activité est invalide.');
    const value = parsed as Record<string, unknown>;
    if (value.schemaVersion !== AUDIT_SCHEMA || !Array.isArray(value.events)) throw new Error('Le journal d’activité utilise un schéma non pris en charge.');
    this.events = value.events.filter((event): event is AuditEvent => {
      if (typeof event !== 'object' || event === null || Array.isArray(event)) return false;
      const record = event as Record<string, unknown>;
      return typeof record.id === 'string' && /^[0-9a-f-]{36}$/i.test(record.id)
        && typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp))
        && typeof record.actor === 'string' && record.actor.length <= 80
        && typeof record.role === 'string' && VALID_ROLES.has(record.role)
        && typeof record.action === 'string' && record.action.length <= 64
        && typeof record.detail === 'string' && record.detail.length <= 300;
    }).slice(-MAX_EVENTS);
  }

  list(limit = 100): AuditEvent[] {
    const count = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.events.slice(-count).reverse().map((event) => ({ ...event }));
  }

  record(principal: PanelPrincipal | null, action: string, detail = ''): Promise<void> {
    const event: AuditEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actor: principal?.username ?? 'system',
      role: principal?.role ?? 'owner',
      action: action.replace(/[^a-z0-9-]/gi, '-').slice(0, 64) || 'operation',
      detail: detail.replace(/[\r\n\0\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
    const write = this.queue.then(async () => {
      this.events = [...this.events, event].slice(-MAX_EVENTS);
      const store: AuditStore = { schemaVersion: AUDIT_SCHEMA, events: this.events };
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.queue = write.catch((error) => {
      console.warn(`[audit] Could not persist activity log: ${(error as Error).message}`);
    });
    return write;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
