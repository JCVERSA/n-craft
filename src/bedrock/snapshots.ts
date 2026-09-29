import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type {
  SnapshotReason,
  SnapshotManagerSnapshot,
  SnapshotSettings,
  WorldSnapshot,
} from '../types/backend.ts';
import type { BedrockConsole } from './console.ts';
import { extractZipSafely } from './extractArchive.ts';
import { MAX_ARCHIVE_ENTRIES, MAX_UNPACKED_BYTES } from './limits.ts';
import type { StateStore } from '../state.ts';
import { WorldManager, WorldManagerError } from './worldManager.ts';

const INDEX_SCHEMA = 1;
const MAX_WORLD_ENTRIES = Math.min(150_000, MAX_ARCHIVE_ENTRIES);
const DISK_HEADROOM_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_BYTES = 10 * 1024 ** 3;
const SAVE_QUERY_TIMEOUT_MS = 3_500;
const SAVE_QUERY_ATTEMPTS = 10;
const SAVE_READY_MARKER = /files are (?:now )?ready to be copied/i;

interface SaveFileSpec {
  path: string;
  sizeBytes: number;
}

interface SnapshotIndex {
  schemaVersion: number;
  settings: Omit<SnapshotSettings, 'nextRunAt' | 'lastRunAt' | 'lastError'>;
  records: WorldSnapshot[];
  lastRunAt: string | null;
  lastError: string | null;
}

interface RestoreJournal {
  schemaVersion: 1;
  worldId: string;
  folder: string;
  stagingName: string;
  previousName: string;
}

export class SnapshotManagerError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'SnapshotManagerError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function assertNoSymlinkInPath(directory: string): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new SnapshotManagerError('Opération refusée : un dossier de stockage contient un lien symbolique.', 409);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validateSettings(value: unknown, fallback?: SnapshotIndex['settings']): SnapshotIndex['settings'] {
  if (!isRecord(value)) {
    if (fallback) return fallback;
    return { enabled: false, intervalHours: 24, retentionPerWorld: 3, maxStorageBytes: DEFAULT_MAX_STORAGE_BYTES };
  }
  const { enabled, intervalHours, retentionPerWorld, maxStorageBytes } = value;
  if (typeof enabled !== 'boolean') throw new SnapshotManagerError('Le réglage snapshots.enabled doit être booléen.');
  if (!Number.isInteger(intervalHours) || Number(intervalHours) < 1 || Number(intervalHours) > 168) {
    throw new SnapshotManagerError('L’intervalle de sauvegarde doit être compris entre 1 et 168 heures.');
  }
  if (!Number.isInteger(retentionPerWorld) || Number(retentionPerWorld) < 1 || Number(retentionPerWorld) > 20) {
    throw new SnapshotManagerError('La rétention doit conserver de 1 à 20 snapshots par monde.');
  }
  if (!Number.isSafeInteger(maxStorageBytes) || Number(maxStorageBytes) < 512 * 1024 ** 2 || Number(maxStorageBytes) > 1024 ** 4) {
    throw new SnapshotManagerError('Le plafond de stockage doit être compris entre 512 Mio et 1 Tio.');
  }
  return {
    enabled,
    intervalHours: Number(intervalHours),
    retentionPerWorld: Number(retentionPerWorld),
    maxStorageBytes: Number(maxStorageBytes),
  };
}

function cleanRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new SnapshotManagerError('Bedrock a renvoyé un chemin de sauvegarde invalide.', 409);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\r\n\0]/.test(part))) {
    throw new SnapshotManagerError('Bedrock a renvoyé un chemin relatif dangereux.', 409);
  }
  return parts.join('/');
}

function toWorldRelativePath(reportedPath: string, worldFolder: string): string {
  const normalized = reportedPath.trim().replace(/^\.\//, '');
  const prefixes = [`worlds/${worldFolder}/`, `${worldFolder}/`];
  const matchedPrefix = prefixes.find((prefix) => normalized.startsWith(prefix));
  let relative: string;
  if (matchedPrefix) relative = normalized.slice(matchedPrefix.length);
  else if (normalized.startsWith('worlds/')) {
    throw new SnapshotManagerError('save query a référencé un dossier de monde différent ; la sauvegarde a été annulée.', 409);
  } else {
    relative = normalized;
  }
  const safe = cleanRelativePath(relative);
  if (safe !== 'level.dat' && !safe.startsWith('db/')) {
    throw new SnapshotManagerError(`save query a référencé un fichier hors du dossier du monde (${safe}).`, 409);
  }
  return safe;
}

/** Parses only the ready-to-copy portion of a BDS save query response. */
export function parseSaveQueryOutput(lines: readonly string[], worldFolder: string): SaveFileSpec[] | null {
  const output = lines.join('\n');
  const marker = SAVE_READY_MARKER.exec(output);
  if (!marker || marker.index === undefined) return null;

  const payload = output.slice(marker.index + marker[0].length);
  const found = new Map<string, number>();
  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*\[[^\]]{1,120}\]\s*/, '').trim();
    if (!line) continue;
    for (const item of line.split(',')) {
      const entry = item.trim();
      const separator = entry.lastIndexOf(':');
      if (separator <= 0) continue;
      const rawPath = entry.slice(0, separator).trim();
      const lengthText = entry.slice(separator + 1).trim();
      if (!/^\d+$/.test(lengthText)) continue;
      const sizeBytes = Number(lengthText);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new SnapshotManagerError('save query a renvoyé une longueur de fichier invalide.', 409);
      }
      const relativePath = toWorldRelativePath(rawPath, worldFolder);
      if (found.has(relativePath)) throw new SnapshotManagerError('save query a renvoyé un fichier en double.', 409);
      found.set(relativePath, sizeBytes);
      if (found.size > MAX_WORLD_ENTRIES) throw new SnapshotManagerError('Le snapshot Bedrock contient trop de fichiers.', 413);
    }
  }

  if (!found.has('level.dat') || ![...found.keys()].some((file) => file.startsWith('db/'))) return null;
  return [...found].map(([filePath, sizeBytes]) => ({ path: filePath, sizeBytes }));
}

async function ensureRegularWorldDirectory(directory: string): Promise<void> {
  const rootInfo = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new SnapshotManagerError('Le dossier du monde est absent ou non sûr.', 409);
  const [levelInfo, dbInfo] = await Promise.all([
    lstat(path.join(directory, 'level.dat')).catch(() => null),
    lstat(path.join(directory, 'db')).catch(() => null),
  ]);
  if (!levelInfo?.isFile() || levelInfo.isSymbolicLink() || !dbInfo?.isDirectory() || dbInfo.isSymbolicLink()) {
    throw new SnapshotManagerError('Le monde est incomplet : level.dat ou db est absent.', 409);
  }
}

async function validateWorldTree(directory: string): Promise<{ count: number; sizeBytes: number }> {
  const stack = [directory];
  let count = 0;
  let sizeBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      count += 1;
      if (count > MAX_WORLD_ENTRIES) throw new SnapshotManagerError('Le monde contient trop de fichiers pour être sauvegardé.', 413);
      const filePath = path.join(current, entry.name);
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) throw new SnapshotManagerError('Snapshot refusé : le monde contient un lien symbolique.', 409);
      if (info.isDirectory()) stack.push(filePath);
      else if (info.isFile()) {
        sizeBytes += info.size;
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes > MAX_UNPACKED_BYTES) {
          throw new SnapshotManagerError('Le monde dépasse la taille maximale décompressée prise en charge.', 413);
        }
      } else throw new SnapshotManagerError('Snapshot refusé : le monde contient un type de fichier non pris en charge.', 409);
    }
  }
  return { count, sizeBytes };
}

async function copyExactPrefix(sourcePath: string, destinationPath: string, expectedBytes: number): Promise<void> {
  const sourceInfo = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < expectedBytes) {
    throw new SnapshotManagerError(`Le fichier annoncé par Bedrock est absent ou plus court que prévu : ${path.basename(sourcePath)}.`, 409);
  }
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const source = await open(sourcePath, 'r');
  let destination;
  try {
    destination = await open(destinationPath, 'wx', 0o600);
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(1024 * 1024, expectedBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new SnapshotManagerError('Un fichier du monde a changé pendant sa copie ; snapshot annulé.', 409);
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten <= 0) throw new SnapshotManagerError('Écriture incomplète du snapshot.', 507);
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await destination.sync();
  } finally {
    await source.close().catch(() => undefined);
    await destination?.close().catch(() => undefined);
  }
}

async function copyWorldTree(source: string, destination: string): Promise<void> {
  await ensureRegularWorldDirectory(source);
  await validateWorldTree(source);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const stack: Array<{ source: string; destination: string }> = [{ source, destination }];
  let copied = 0;
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of await readdir(current.source, { withFileTypes: true })) {
      copied += 1;
      if (copied > MAX_WORLD_ENTRIES) throw new SnapshotManagerError('Le monde contient trop de fichiers pour être sauvegardé.', 413);
      const from = path.join(current.source, entry.name);
      const to = path.join(current.destination, entry.name);
      const info = await lstat(from);
      if (info.isSymbolicLink()) throw new SnapshotManagerError('Snapshot refusé : le monde contient un lien symbolique.', 409);
      if (info.isDirectory()) {
        await mkdir(to, { mode: 0o700 });
        stack.push({ source: from, destination: to });
      } else if (info.isFile()) {
        await copyExactPrefix(from, to, info.size);
      } else throw new SnapshotManagerError('Snapshot refusé : le monde contient un type de fichier non pris en charge.', 409);
    }
  }
}

async function makeZip(sourceDirectory: string, destinationPath: string): Promise<void> {
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }));
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: sourceDirectory, relative: '' }];
  let entries = 0;
  try {
    while (stack.length) {
      const current = stack.pop()!;
      for (const entry of await readdir(current.absolute, { withFileTypes: true })) {
        entries += 1;
        if (entries > MAX_WORLD_ENTRIES) throw new SnapshotManagerError('Le monde contient trop de fichiers pour être archivé.', 413);
        const absolute = path.join(current.absolute, entry.name);
        const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new SnapshotManagerError('Archive refusée : le staging contient un lien symbolique.', 409);
        if (info.isDirectory()) stack.push({ absolute, relative });
        else if (info.isFile()) zip.addFile(absolute, relative, { mtime: info.mtime, mode: 0o100600, compress: true });
        else throw new SnapshotManagerError('Archive refusée : le staging contient un type de fichier non pris en charge.', 409);
      }
    }
    zip.end();
    await writing;
  } catch (error) {
    (zip.outputStream as import('node:stream').Readable).destroy(error as Error);
    await writing.catch(() => undefined);
    throw error;
  }
}

export class BedrockSnapshotManager {
  readonly snapshotsDirectory: string;
  private readonly indexPath: string;
  private settings: SnapshotIndex['settings'] = validateSettings(null);
  private records: WorldSnapshot[] = [];
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private nextRunAt: Date | null = null;
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<unknown> | null = null;
  private readonly operations = new Set<Promise<unknown>>();
  private indexQueue: Promise<void> = Promise.resolve();
  private started = false;
  private shuttingDown = false;

  constructor(
    private readonly dataDirectory: string,
    private readonly worldManager: WorldManager,
    private readonly bedrockConsole: BedrockConsole,
    private readonly state: StateStore,
  ) {
    this.snapshotsDirectory = path.join(dataDirectory, 'snapshots');
    this.indexPath = path.join(this.snapshotsDirectory, 'index.json');
  }

  async initialize(): Promise<void> {
    await assertNoSymlinkInPath(this.dataDirectory);
    await mkdir(this.snapshotsDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(this.snapshotsDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new SnapshotManagerError('Le dossier des snapshots n’est pas sûr.', 409);
    const indexInfo = await lstat(this.indexPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (indexInfo && (!indexInfo.isFile() || indexInfo.isSymbolicLink())) throw new SnapshotManagerError('Le registre des snapshots n’est pas un fichier ordinaire.', 409);

    const parsed = await readFile(this.indexPath, 'utf8').then((content) => JSON.parse(content) as unknown).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new SnapshotManagerError('Le registre des snapshots est illisible ; les archives n’ont pas été modifiées.', 409);
    });
    if (parsed !== null) {
      if (!isRecord(parsed) || parsed.schemaVersion !== INDEX_SCHEMA || !Array.isArray(parsed.records)) {
        throw new SnapshotManagerError('Le registre des snapshots utilise un format non pris en charge.', 409);
      }
      this.settings = validateSettings(parsed.settings);
      this.lastRunAt = typeof parsed.lastRunAt === 'string' && !Number.isNaN(Date.parse(parsed.lastRunAt)) ? parsed.lastRunAt : null;
      this.lastError = typeof parsed.lastError === 'string' ? parsed.lastError.slice(0, 1000) : null;
      const records: WorldSnapshot[] = [];
      for (const [index, value] of parsed.records.entries()) {
        if (!isRecord(value) || !isUuid(value.id) || !isUuid(value.worldId)
          || typeof value.worldName !== 'string' || value.worldName.length > 80
          || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
          || !['manual', 'scheduled', 'before-deploy', 'before-restore'].includes(String(value.reason))) {
          throw new SnapshotManagerError(`Métadonnée de snapshot #${index + 1} invalide.`, 409);
        }
        const archivePath = this.archivePath(value.id);
        const info = await lstat(archivePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink()) throw new SnapshotManagerError(`Archive snapshot #${index + 1} non sûre.`, 409);
        records.push({
          id: value.id,
          worldId: value.worldId,
          worldName: value.worldName,
          createdAt: value.createdAt,
          reason: value.reason as SnapshotReason,
          sizeBytes: info.size,
        });
      }
      this.records = records;
    }
    await this.recoverInterruptedRestore();
    await this.persistIndex();
  }

  start(): void {
    if (this.started || this.shuttingDown) return;
    this.started = true;
    if (this.settings.enabled) {
      const base = this.lastRunAt ? Date.parse(this.lastRunAt) : Date.now();
      this.nextRunAt = new Date(Math.max(Date.now(), base + this.intervalMs()));
      this.scheduleNext();
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.all([...this.operations].map((operation) => operation.catch(() => undefined)));
    await this.activeRun?.catch(() => undefined);
    await this.indexQueue;
  }

  getSnapshot(): SnapshotManagerSnapshot {
    const storageUsedBytes = this.records.reduce((sum, record) => sum + record.sizeBytes, 0);
    return {
      settings: {
        ...this.settings,
        nextRunAt: this.nextRunAt?.toISOString() ?? null,
        lastRunAt: this.lastRunAt,
        lastError: this.lastError,
      },
      snapshots: this.records.map((record) => ({ ...record })),
      storageUsedBytes,
      diskFreeBytes: null,
      diskWarning: storageUsedBytes >= this.settings.maxStorageBytes,
    };
  }

  async getSnapshotWithDisk(): Promise<SnapshotManagerSnapshot> {
    const snapshot = this.getSnapshot();
    const diskFreeBytes = await this.readFreeBytes().catch(() => null);
    return {
      ...snapshot,
      diskFreeBytes,
      diskWarning: snapshot.diskWarning || (diskFreeBytes !== null && diskFreeBytes < DISK_HEADROOM_BYTES),
    };
  }

  listForWorld(worldId: string): WorldSnapshot[] {
    return this.records.filter((record) => record.worldId === worldId).map((record) => ({ ...record }));
  }

  async updateSettings(input: unknown): Promise<SnapshotManagerSnapshot> {
    const next = validateSettings(input);
    const previous = this.settings;
    this.settings = next;
    try {
      await this.persistIndex();
    } catch (error) {
      this.settings = previous;
      throw error;
    }
    if (this.started) this.scheduleNext();
    return this.getSnapshotWithDisk();
  }

  createSnapshot(worldId: string, reason: SnapshotReason = 'manual'): Promise<WorldSnapshot> {
    if (this.shuttingDown) return Promise.reject(new SnapshotManagerError('Le panneau s’arrête ; aucun nouveau snapshot ne sera lancé.', 503));
    return this.trackOperation(this.worldManager.withExclusiveOperation(() => this.createSnapshotInternal(worldId, reason)));
  }

  async deleteSnapshot(id: string): Promise<void> {
    if (!isUuid(id)) throw new SnapshotManagerError('Identifiant de snapshot invalide.');
    if (this.shuttingDown) throw new SnapshotManagerError('Le panneau s’arrête ; aucune archive ne sera supprimée.', 503);
    await this.trackOperation(this.worldManager.withExclusiveOperation(async () => {
      const index = this.records.findIndex((record) => record.id === id);
      if (index < 0) throw new SnapshotManagerError('Snapshot introuvable.', 404);
      const record = this.records[index]!;
      this.records.splice(index, 1);
      try {
        await this.persistIndex();
        await rm(this.archivePath(id), { force: true });
      } catch (error) {
        if (!this.records.some((candidate) => candidate.id === id)) this.records.splice(index, 0, record);
        await this.persistIndex().catch(() => undefined);
        throw error;
      }
      console.info(`[snapshots] Deleted snapshot ${record.id} (${record.reason}).`);
    }));
  }

  async getArchive(id: string): Promise<{ fileName: string; stream: NodeJS.ReadableStream }> {
    if (!isUuid(id)) throw new SnapshotManagerError('Identifiant de snapshot invalide.');
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) throw new SnapshotManagerError('Snapshot introuvable.', 404);
    const archivePath = this.archivePath(id);
    const info = await lstat(archivePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile() || info.isSymbolicLink()) throw new SnapshotManagerError('L’archive snapshot est absente ou non sûre.', 404);
    const worldName = record.worldName.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'monde';
    const timestamp = record.createdAt.replace(/[^0-9T]/g, '').slice(0, 15) || record.id.slice(0, 8);
    return { fileName: `${worldName}-${timestamp}.mcworld`, stream: createReadStream(archivePath) };
  }

  async restoreSnapshot(id: string): Promise<{ restored: WorldSnapshot; beforeRestore: WorldSnapshot | null }> {
    if (!isUuid(id)) throw new SnapshotManagerError('Identifiant de snapshot invalide.');
    if (this.shuttingDown) throw new SnapshotManagerError('Le panneau s’arrête ; aucune restauration ne sera lancée.', 503);
    try {
      return await this.trackOperation(this.worldManager.withExclusiveOperation(async () => {
        const record = this.records.find((candidate) => candidate.id === id);
        if (!record) throw new SnapshotManagerError('Snapshot introuvable.', 404);
        const server = this.state.getSnapshot().server;
        if (this.bedrockConsole.isRunning || server.status === 'running' || server.status === 'starting' || server.status === 'stopping'
          || (server.status === 'failed' && server.pid !== null)) {
          throw new SnapshotManagerError('Arrête Bedrock complètement avant de restaurer un snapshot.', 409);
        }
        if (this.state.getSnapshot().pipeline.status === 'running') {
          throw new SnapshotManagerError('Attends la fin du déploiement avant de restaurer un snapshot.', 409);
        }
        const world = this.worldManager.getWorld(record.worldId);
        const worldDirectory = path.join(this.worldManager.worldsDirectory, world.folder);
        await assertNoSymlinkInPath(this.worldManager.worldsDirectory);
        const existingInfo = await lstat(worldDirectory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        let beforeRestore: WorldSnapshot | null = null;
        if (existingInfo) {
          if (existingInfo.isSymbolicLink() || !existingInfo.isDirectory()) throw new SnapshotManagerError('Le dossier courant du monde n’est pas sûr.', 409);
          await ensureRegularWorldDirectory(worldDirectory);
          beforeRestore = await this.createSnapshotInternal(record.worldId, 'before-restore', record.id);
        }

        const stagingName = `.ncraft-restore-stage-${randomUUID()}`;
        const previousName = `.ncraft-restore-previous-${randomUUID()}`;
        const stagingDirectory = path.join(this.worldManager.worldsDirectory, stagingName);
        const previousDirectory = path.join(this.worldManager.worldsDirectory, previousName);
        const archivePath = this.archivePath(record.id);
        await ensureRegularArchive(archivePath);
        const journalPath = this.journalPath(record.worldId);
        let oldMoved = false;
        try {
          const journal: RestoreJournal = { schemaVersion: 1, worldId: record.worldId, folder: world.folder, stagingName, previousName };
          await this.writeAtomic(journalPath, `${JSON.stringify(journal)}\n`);
          await extractZipSafely(archivePath, stagingDirectory);
          await ensureRegularWorldDirectory(stagingDirectory);
          await validateWorldTree(stagingDirectory);
          if (existingInfo) {
            await rename(worldDirectory, previousDirectory);
            oldMoved = true;
          }
          await rename(stagingDirectory, worldDirectory);
          if (oldMoved) await rm(previousDirectory, { recursive: true, force: true });
          await rm(journalPath, { force: true });
          const refreshed = { ...record, reason: 'manual' as const, createdAt: new Date().toISOString() };
          console.info(`[snapshots] Restored ${record.id} into world ${record.worldId}.`);
          return { restored: refreshed, beforeRestore };
        } catch (error) {
          const targetExists = await lstat(worldDirectory).then(() => true).catch(() => false);
          let rolledBack = false;
          if (oldMoved && !targetExists) {
            try {
              await rename(previousDirectory, worldDirectory);
              rolledBack = true;
            } catch {
              // Keep the journal and original folder so startup recovery can retry safely.
            }
          }
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
          if (!oldMoved || targetExists || rolledBack) await rm(journalPath, { force: true }).catch(() => undefined);
          throw error;
        }
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new SnapshotManagerError('Espace disque épuisé pendant la restauration ; le monde précédent a été conservé ou restauré.', 507);
      }
      throw error;
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = operation.finally(() => this.operations.delete(tracked));
    this.operations.add(tracked);
    return tracked;
  }

  private async createSnapshotInternal(worldId: string, reason: SnapshotReason, protectedSnapshotId?: string): Promise<WorldSnapshot> {
    const world = this.worldManager.getWorld(worldId);
    const worldDirectory = path.join(this.worldManager.worldsDirectory, world.folder);
    await assertNoSymlinkInPath(this.worldManager.serverDirectoryPath);
    await assertNoSymlinkInPath(this.snapshotsDirectory);
    await ensureRegularWorldDirectory(worldDirectory);

    const id = randomUUID();
    const captureDirectory = path.join(this.snapshotsDirectory, `.capture-${id}`);
    const temporaryArchivePath = path.join(this.snapshotsDirectory, `.snapshot-${id}.tmp`);
    const archivePath = this.archivePath(id);
    let sourceBytes = 0;
    let holdAttempted = false;
    try {
      await mkdir(captureDirectory, { recursive: false, mode: 0o700 });
      const panelState = this.state.getSnapshot();
      const server = panelState.server;
      const activeConfig = panelState.activeConfig;
      if ((server.status === 'starting' || server.status === 'stopping'
        || (server.status === 'failed' && server.pid !== null))
        || (this.bedrockConsole.isRunning && !this.bedrockConsole.isReady)) {
        throw new SnapshotManagerError('Le serveur change d’état ; attends qu’il soit complètement prêt ou arrêté avant de sauvegarder.', 409);
      }
      const isActiveOnlineWorld = this.bedrockConsole.isReady
        && server.status === 'running'
        && activeConfig?.levelName === world.folder
        && activeConfig.version === world.version;

      if (isActiveOnlineWorld) {
        holdAttempted = true;
        if (!this.bedrockConsole.sendCommand('save hold')) {
          throw new SnapshotManagerError('Impossible d’envoyer « save hold » à Bedrock ; aucun fichier n’a été copié.', 409);
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        let fileList: SaveFileSpec[] | null = null;
        for (let attempt = 0; attempt < SAVE_QUERY_ATTEMPTS && !fileList; attempt += 1) {
          if (!this.bedrockConsole.isReady) throw new SnapshotManagerError('Bedrock s’est arrêté pendant la préparation du snapshot.', 409);
          const lines = await this.bedrockConsole.waitForCommandOutput(
            'save query',
            (output) => SAVE_READY_MARKER.test(output.join('\n')),
            SAVE_QUERY_TIMEOUT_MS,
            220,
          );
          if (lines) fileList = parseSaveQueryOutput(lines, world.folder);
          if (!fileList && attempt + 1 < SAVE_QUERY_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 400));
        }
        if (!fileList) throw new SnapshotManagerError('Bedrock n’a pas renvoyé une liste de fichiers copiable après 10 requêtes « save query ». Réessaie ou crée le snapshot serveur arrêté.', 504);
        sourceBytes = fileList.reduce((sum, file) => sum + file.sizeBytes, 0);
        if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_UNPACKED_BYTES) {
          throw new SnapshotManagerError('Le snapshot dépasserait la taille maximale décompressée prise en charge.', 413);
        }
        await this.assertAvailableDisk(sourceBytes);
        for (const file of fileList) {
          const from = path.resolve(worldDirectory, ...file.path.split('/'));
          const root = path.resolve(worldDirectory);
          if (!from.startsWith(`${root}${path.sep}`)) throw new SnapshotManagerError('Chemin de snapshot hors du monde actif refusé.', 409);
          await copyExactPrefix(from, path.join(captureDirectory, ...file.path.split('/')), file.sizeBytes);
        }
      } else {
        const tree = await validateWorldTree(worldDirectory);
        sourceBytes = tree.sizeBytes;
        await this.assertAvailableDisk(sourceBytes);
        await rm(captureDirectory, { recursive: true, force: true });
        await copyWorldTree(worldDirectory, captureDirectory);
      }

      await ensureRegularWorldDirectory(captureDirectory);
      await makeZip(captureDirectory, temporaryArchivePath);
      const archiveInfo = await lstat(temporaryArchivePath);
      if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new SnapshotManagerError('Archive temporaire de snapshot non sûre.', 409);
      const record: WorldSnapshot = {
        id,
        worldId,
        worldName: world.name,
        createdAt: new Date().toISOString(),
        reason,
        sizeBytes: archiveInfo.size,
      };
      const recordsBefore = this.records;
      const lastRunAtBefore = this.lastRunAt;
      const lastErrorBefore = this.lastError;
      const pruned = this.planPruning(record, protectedSnapshotId);
      await rename(temporaryArchivePath, archivePath);
      this.records = [...this.records.filter((candidate) => !pruned.includes(candidate.id)), record];
      if (reason === 'scheduled') this.lastRunAt = record.createdAt;
      this.lastError = null;
      try {
        await this.persistIndex();
      } catch (error) {
        this.records = recordsBefore;
        this.lastRunAt = lastRunAtBefore;
        this.lastError = lastErrorBefore;
        await rm(archivePath, { force: true }).catch(() => undefined);
        throw error;
      }
      await Promise.all(pruned.map((prunedId) => rm(this.archivePath(prunedId), { force: true })));
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new SnapshotManagerError('Espace disque épuisé pendant la sauvegarde ; l’archive incomplète a été nettoyée. Libère de l’espace puis réessaie.', 507);
      }
      throw error;
    } finally {
      if (holdAttempted) {
        const resumed = this.bedrockConsole.sendCommand('save resume');
        if (!resumed) console.warn('[snapshots] Could not send "save resume"; Bedrock may already have stopped.');
      }
      await rm(captureDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(temporaryArchivePath, { force: true }).catch(() => undefined);
    }
  }

  private planPruning(next: WorldSnapshot, protectedSnapshotId?: string): string[] {
    const deletions = new Set<string>();
    const protectedIds = new Set<string>();
    if (next.reason === 'before-restore') protectedIds.add(next.id);
    if (protectedSnapshotId) protectedIds.add(protectedSnapshotId);
    const ordered = [...this.records].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const sameWorld = [...ordered.filter((record) => record.worldId === next.worldId), next];
    while (sameWorld.filter((record) => !deletions.has(record.id)).length > this.settings.retentionPerWorld) {
      const oldest = sameWorld.find((record) => record.id !== next.id && record.id !== protectedSnapshotId && !deletions.has(record.id));
      if (!oldest) break;
      deletions.add(oldest.id);
    }

    let total = this.records.filter((record) => !deletions.has(record.id)).reduce((sum, record) => sum + record.sizeBytes, next.sizeBytes);
    for (const candidate of ordered) {
      if (total <= this.settings.maxStorageBytes) break;
      if (protectedIds.has(candidate.id)) continue;
      const perWorldRemaining = this.records.filter((record) => record.worldId === candidate.worldId && !deletions.has(record.id)).length
        + (candidate.worldId === next.worldId ? 1 : 0);
      if (perWorldRemaining <= 1) continue;
      if (deletions.has(candidate.id)) continue;
      deletions.add(candidate.id);
      total -= candidate.sizeBytes;
    }
    if (total > this.settings.maxStorageBytes) {
      throw new SnapshotManagerError('Le plafond de stockage des snapshots serait dépassé. Augmente le plafond ou supprime d’anciennes archives.', 507);
    }
    return [...deletions];
  }

  private async assertAvailableDisk(uncompressedBytes: number): Promise<void> {
    const freeBytes = await this.readFreeBytes();
    if (freeBytes === null) return;
    // A temporary world copy and the final ZIP coexist until the archive is committed.
    const required = Math.max(DISK_HEADROOM_BYTES, uncompressedBytes * 2 + DISK_HEADROOM_BYTES);
    if (freeBytes < required) {
      const free = `${(freeBytes / 1024 ** 3).toFixed(2)} Go`;
      const needed = `${(required / 1024 ** 3).toFixed(2)} Go`;
      throw new SnapshotManagerError(`Espace disque insuffisant pour une sauvegarde sûre : ${free} libres, environ ${needed} requis. Libère de l’espace puis réessaie.`, 507);
    }
  }

  private async readFreeBytes(): Promise<number | null> {
    let candidate = path.resolve(this.snapshotsDirectory);
    while (true) {
      try {
        const values = await statfs(candidate, { bigint: true });
        const bytes = values.bavail * values.bsize;
        return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
      } catch {
        const parent = path.dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
      }
    }
  }

  private intervalMs(): number {
    return this.settings.intervalHours * 60 * 60 * 1000;
  }

  private scheduleNext(): void {
    if (this.shuttingDown) return;
    if (this.timer) clearTimeout(this.timer);
    if (!this.settings.enabled) {
      this.timer = null;
      this.nextRunAt = null;
      return;
    }
    if (!this.nextRunAt || this.nextRunAt.getTime() <= Date.now()) this.nextRunAt = new Date(Date.now() + this.intervalMs());
    const delay = Math.min(Math.max(1, this.nextRunAt.getTime() - Date.now()), 24 * 60 * 60 * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.nextRunAt && this.nextRunAt.getTime() > Date.now()) {
        this.scheduleNext();
        return;
      }
      const operation = this.runScheduledSnapshot();
      this.activeRun = operation;
      void operation.catch((error) => {
        this.lastError = (error as Error).message || 'Échec inattendu du snapshot automatique.';
        console.error(`[snapshots] ${this.lastError}`);
        void this.persistIndex().catch(() => undefined);
      }).finally(() => {
        if (this.activeRun === operation) this.activeRun = null;
        this.nextRunAt = this.settings.enabled ? new Date(Date.now() + this.intervalMs()) : null;
        this.scheduleNext();
      });
    }, delay);
    this.timer.unref?.();
  }

  private async runScheduledSnapshot(): Promise<void> {
    const activeConfiguration = this.state.getSnapshot().activeConfig;
    if (!activeConfiguration) throw new SnapshotManagerError('Aucun monde actif : le snapshot planifié est ignoré.', 409);
    const world = this.worldManager.findByVersionAndFolder(activeConfiguration.version, activeConfiguration.levelName);
    if (!world) throw new SnapshotManagerError('Le monde actif n’est plus présent dans le registre.', 409);
    await this.createSnapshot(world.id, 'scheduled');
  }

  private archivePath(id: string): string {
    return path.join(this.snapshotsDirectory, `snapshot-${id}.mcworld`);
  }

  private journalPath(worldId: string): string {
    return path.join(this.snapshotsDirectory, `restore-${worldId}.json`);
  }

  private async recoverInterruptedRestore(): Promise<void> {
    for (const entry of await readdir(this.snapshotsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^restore-[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
      const journalPath = path.join(this.snapshotsDirectory, entry.name);
      const journalInfo = await lstat(journalPath);
      if (journalInfo.isSymbolicLink() || !journalInfo.isFile()) throw new SnapshotManagerError('Journal de restauration non sûr.', 409);
      let value: unknown;
      try { value = JSON.parse(await readFile(journalPath, 'utf8')) as unknown; }
      catch { throw new SnapshotManagerError('Journal de restauration illisible ; les fichiers de monde ont été laissés intacts.', 409); }
      if (!isRecord(value) || value.schemaVersion !== 1 || !isUuid(value.worldId)
        || typeof value.folder !== 'string' || typeof value.stagingName !== 'string' || typeof value.previousName !== 'string'
        || !/^\.ncraft-restore-(?:stage|previous)-[0-9a-f-]{36}$/i.test(value.stagingName)
        || !/^\.ncraft-restore-(?:stage|previous)-[0-9a-f-]{36}$/i.test(value.previousName)) {
        throw new SnapshotManagerError('Journal de restauration invalide ; aucune récupération automatique n’a été tentée.', 409);
      }
      const world = this.worldManager.getWorld(value.worldId);
      if (world.folder !== value.folder) throw new SnapshotManagerError('Le journal de restauration ne correspond plus au registre des mondes.', 409);
      const destination = path.join(this.worldManager.worldsDirectory, world.folder);
      const staging = path.join(this.worldManager.worldsDirectory, value.stagingName);
      const previous = path.join(this.worldManager.worldsDirectory, value.previousName);
      const destinationExists = await lstat(destination).then((info) => info.isDirectory() && !info.isSymbolicLink()).catch(() => false);
      const previousExists = await lstat(previous).then((info) => info.isDirectory() && !info.isSymbolicLink()).catch(() => false);
      if (!destinationExists && previousExists) await rename(previous, destination);
      else if (destinationExists && previousExists) await rm(previous, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      await rm(journalPath, { force: true });
      console.warn(`[snapshots] Recovered interrupted restore for world ${value.worldId}.`);
    }
  }

  private async writeAtomic(filePath: string, contents: string): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await assertNoSymlinkInPath(path.dirname(filePath));
    try {
      await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private persistIndex(): Promise<void> {
    const write = this.indexQueue.then(async () => {
      await assertNoSymlinkInPath(this.snapshotsDirectory);
      const index: SnapshotIndex = {
        schemaVersion: INDEX_SCHEMA,
        settings: this.settings,
        records: this.records,
        lastRunAt: this.lastRunAt,
        lastError: this.lastError,
      };
      await this.writeAtomic(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
    });
    this.indexQueue = write.catch((error) => {
      console.error(`[snapshots] Could not persist index: ${(error as Error).message}`);
    });
    return write;
  }
}

async function ensureRegularArchive(archivePath: string): Promise<void> {
  const info = await lstat(archivePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) throw new SnapshotManagerError('L’archive à restaurer est absente ou non sûre.', 404);
}
