import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BedrockConsole } from './console.ts';
import type { ManagedPlayer } from '../types/backend.ts';
import type { PlayerLifecycleDetails } from './playerTracker.ts';

const ROSTER_SCHEMA = 1;
const MAX_PLAYERS = 2000;

interface RosterFile {
  schemaVersion: number;
  players: ManagedPlayer[];
}

export class PlayerRoster {
  private readonly filePath: string;
  private players = new Map<string, ManagedPlayer>();
  private queue: Promise<void> = Promise.resolve();
  private readonly onPlayer = (event: PlayerLifecycleDetails) => this.recordEvent(event);

  constructor(dataDirectory: string, private readonly bedrockConsole: BedrockConsole) {
    this.filePath = path.join(dataDirectory, 'players.json');
    this.bedrockConsole.on('player', this.onPlayer);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('format invalide');
      const value = parsed as Record<string, unknown>;
      if (value.schemaVersion !== ROSTER_SCHEMA || !Array.isArray(value.players)) throw new Error('schéma invalide');
      const now = new Date().toISOString();
      for (const item of value.players.slice(-MAX_PLAYERS)) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.id !== 'string' || typeof record.name !== 'string'
          || typeof record.firstSeenAt !== 'string' || Number.isNaN(Date.parse(record.firstSeenAt))
          || typeof record.lastSeenAt !== 'string' || Number.isNaN(Date.parse(record.lastSeenAt))) continue;
        const xuid = typeof record.xuid === 'string' && /^\d{1,20}$/.test(record.xuid) ? record.xuid : null;
        const player: ManagedPlayer = {
          id: record.id.slice(0, 128),
          xuid,
          name: record.name.slice(0, 80),
          online: false,
          firstSeenAt: record.firstSeenAt,
          lastSeenAt: record.online === true ? now : record.lastSeenAt,
        };
        this.players.set(player.id, player);
      }
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Le roster des joueurs est illisible : ${(error as Error).message}`);
      }
    }
  }

  list(): ManagedPlayer[] {
    return [...this.players.values()]
      .map((player) => ({ ...player }))
      .sort((left, right) => Number(right.online) - Number(left.online)
        || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
        || left.name.localeCompare(right.name));
  }

  markAllOffline(): Promise<void> {
    const now = new Date().toISOString();
    let changed = false;
    for (const [id, player] of this.players) {
      if (!player.online) continue;
      changed = true;
      this.players.set(id, { ...player, online: false, lastSeenAt: now });
    }
    return changed ? this.persist() : Promise.resolve();
  }

  async shutdown(): Promise<void> {
    this.bedrockConsole.removeListener('player', this.onPlayer);
    await this.queue;
  }

  private recordEvent(event: PlayerLifecycleDetails): void {
    const id = event.playerKey.slice(0, 128);
    const now = new Date().toISOString();
    const current = this.players.get(id);
    this.players.set(id, {
      id,
      xuid: event.xuid,
      name: event.name.slice(0, 80),
      online: event.action === 'connected',
      firstSeenAt: current?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
    if (this.players.size > MAX_PLAYERS) {
      const stale = [...this.players.values()]
        .filter((player) => !player.online)
        .sort((left, right) => Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt));
      while (this.players.size > MAX_PLAYERS && stale.length) this.players.delete(stale.shift()!.id);
    }
    void this.persist().catch((error) => console.warn(`[players] Could not save roster: ${(error as Error).message}`));
  }

  private persist(): Promise<void> {
    const write = this.queue.then(async () => {
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      const file: RosterFile = { schemaVersion: ROSTER_SCHEMA, players: this.list() };
      try {
        await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.queue = write.catch((error) => {
      console.warn(`[players] Could not persist roster: ${(error as Error).message}`);
    });
    return write;
  }
}
