import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import yazl from 'yazl';
import type { DeployConfiguration, ManagedWorld, WorldSelection, WorldSource } from '../types/backend.ts';
import { validateDeployConfiguration } from './configWriter.ts';
import { extractZipSafely } from './extractArchive.ts';

const MANIFEST_SCHEMA = 1;
const FOLDER_PREFIX = 'ncraft_';
const MAX_TREE_ENTRIES = 150_000;
const MAX_NAME_LENGTH = 80;
const WORLD_VERSION_PATTERN = /^\d+(?:\.\d+){1,4}$/;

interface StoredWorld {
  id: string;
  name: string;
  folder: string;
  version: string | null;
  seed: string | null;
  configuration: DeployConfiguration | null;
  source: WorldSource;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

interface WorldManifest {
  schemaVersion: number;
  worlds: StoredWorld[];
}

export class WorldManagerError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'WorldManagerError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeFolderName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && value !== '.'
    && value !== '..'
    && !/[\\/\0\r\n]/.test(value)
    && !/^[A-Za-z]:/.test(value);
}

export function normalizeWorldName(value: unknown): string {
  if (typeof value !== 'string') throw new WorldManagerError('Le nom du monde est obligatoire.');
  const name = value.trim();
  if (!name) throw new WorldManagerError('Le nom du monde est obligatoire.');
  if (name.length > MAX_NAME_LENGTH || /[\\/\0-\x1f\x7f]/.test(name)) {
    throw new WorldManagerError(`Le nom du monde ne peut pas dépasser ${MAX_NAME_LENGTH} caractères ni contenir de chemin.`);
  }
  return name;
}

function safeConfiguration(value: unknown, version: string | null, folder: string): DeployConfiguration | null {
  if (!version || !isRecord(value)) return null;
  try {
    return validateDeployConfiguration({ ...value, version, levelName: folder }, new Set([version]));
  } catch {
    return null;
  }
}

function parseStoredWorld(value: unknown, index: number): StoredWorld {
  if (!isRecord(value)) throw new Error(`Métadonnées du monde #${index + 1} invalides.`);
  const { id, name, folder, version, seed, source, createdAt, updatedAt, lastUsedAt } = value;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Identifiant du monde #${index + 1} invalide.`);
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) throw new Error(`Nom du monde #${index + 1} invalide.`);
  if (!isSafeFolderName(folder)) throw new Error(`Dossier du monde #${index + 1} invalide.`);
  if (version !== null && (typeof version !== 'string' || !WORLD_VERSION_PATTERN.test(version))) {
    throw new Error(`Version BDS du monde #${index + 1} invalide.`);
  }
  if (seed !== null && (typeof seed !== 'string' || seed.length > 80 || /[\r\n\0]/.test(seed))) {
    throw new Error(`Seed du monde #${index + 1} invalide.`);
  }
  if (source !== 'created' && source !== 'imported' && source !== 'legacy') {
    throw new Error(`Source du monde #${index + 1} invalide.`);
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new Error(`Date de création du monde #${index + 1} invalide.`);
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) throw new Error(`Date de modification du monde #${index + 1} invalide.`);
  if (lastUsedAt !== null && (typeof lastUsedAt !== 'string' || Number.isNaN(Date.parse(lastUsedAt)))) {
    throw new Error(`Date de dernière utilisation du monde #${index + 1} invalide.`);
  }

  const normalizedVersion = typeof version === 'string' ? version : null;
  const normalizedSeed = typeof seed === 'string' ? seed : null;
  const configuration = safeConfiguration(value.configuration, normalizedVersion, folder);
  if (configuration) configuration.seed = normalizedSeed ?? '';
  return {
    id,
    name: name.trim(),
    folder,
    version: normalizedVersion,
    seed: normalizedSeed,
    configuration,
    source,
    createdAt,
    updatedAt,
    lastUsedAt: typeof lastUsedAt === 'string' ? lastUsedAt : null,
  };
}

function worldIdFolder(id: string): string {
  return `${FOLDER_PREFIX}${id.replace(/-/g, '').slice(0, 24)}`;
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
    if (info?.isSymbolicLink()) throw new WorldManagerError(`Opération refusée : le chemin ${current} contient un lien symbolique.`, 409);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function isWorldDirectory(directory: string): Promise<boolean> {
  try {
    const rootInfo = await lstat(directory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    const [levelInfo, dbInfo] = await Promise.all([
      lstat(path.join(directory, 'level.dat')).catch(() => null),
      lstat(path.join(directory, 'db')).catch(() => null),
    ]);
    return Boolean(levelInfo?.isFile() && !levelInfo.isSymbolicLink() && dbInfo?.isDirectory() && !dbInfo.isSymbolicLink());
  } catch {
    return false;
  }
}

async function assertNoUnsafeEntries(directory: string): Promise<number> {
  const stack = [directory];
  let entryCount = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) throw new WorldManagerError('Le monde contient trop de fichiers pour cette opération.', 413);
      const fullPath = path.join(current, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new WorldManagerError('Opération refusée : le monde contient un lien symbolique.', 409);
      if (info.isDirectory()) stack.push(fullPath);
      else if (!info.isFile()) throw new WorldManagerError('Opération refusée : le monde contient un type de fichier non pris en charge.', 409);
    }
  }
  return entryCount;
}

async function copyWorldTree(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new WorldManagerError('Le dossier source du monde n’est pas sûr.');
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const stack: Array<{ source: string; destination: string }> = [{ source, destination }];
  let entriesCopied = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current.source, { withFileTypes: true });
    for (const entry of entries) {
      entriesCopied += 1;
      if (entriesCopied > MAX_TREE_ENTRIES) throw new WorldManagerError('Le monde contient trop de fichiers à importer.', 413);
      const sourcePath = path.join(current.source, entry.name);
      const destinationPath = path.join(current.destination, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new WorldManagerError('Import refusé : le monde contient un lien symbolique.');
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        stack.push({ source: sourcePath, destination: destinationPath });
      } else if (info.isFile()) {
        await copyFile(sourcePath, destinationPath);
      } else {
        throw new WorldManagerError('Import refusé : le monde contient un type de fichier non pris en charge.');
      }
    }
  }
}

async function findWorldRoot(extractionDirectory: string): Promise<string> {
  if (await isWorldDirectory(extractionDirectory)) return extractionDirectory;
  const entries = await readdir(extractionDirectory, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(extractionDirectory, entry.name);
    if (await isWorldDirectory(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) throw new WorldManagerError('L’archive contient plusieurs mondes ; importe un fichier .mcworld à la fois.');
  throw new WorldManagerError('Archive invalide : aucun monde Bedrock avec level.dat et db n’a été trouvé.');
}

function archiveName(name: string, version: string | null): string {
  const safeName = name.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'monde';
  const safeVersion = version?.replace(/[^\d.]/g, '') ?? 'non-assigne';
  return `${safeName}-${safeVersion}.mcworld`;
}

export class WorldManager {
  readonly worldsDirectory: string;
  readonly manifestPath: string;
  private records: StoredWorld[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();
  private activeMutations = 0;
  private queuedMutations = 0;
  private activeOperations = 0;
  private queuedOperations = 0;

  constructor(private readonly dataDirectory: string, private readonly serverDirectory: string) {
    this.worldsDirectory = path.join(serverDirectory, 'worlds');
    this.manifestPath = path.join(dataDirectory, 'worlds.json');
  }

  get serverDirectoryPath(): string {
    return this.serverDirectory;
  }

  get isBusy(): boolean {
    return this.activeMutations > 0 || this.queuedMutations > 0 || this.activeOperations > 0 || this.queuedOperations > 0;
  }

  /** Serializes a long-running world read/restore against metadata mutations and server starts. */
  withExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedOperations += 1;
    const execute = async () => {
      this.queuedOperations -= 1;
      if (this.activeOperations > 0) throw new WorldManagerError('Une autre opération protège déjà les mondes.', 409);
      this.activeOperations += 1;
      try {
        return await operation();
      } finally {
        this.activeOperations -= 1;
      }
    };
    const current = this.mutationQueue.then(execute, execute);
    this.mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedMutations += 1;
    const execute = async () => {
      this.queuedMutations -= 1;
      if (this.activeOperations > 0) throw new WorldManagerError('Un instant : une sauvegarde ou une exportation protège actuellement les données du monde.', 409);
      this.activeMutations += 1;
      try {
        return await operation();
      } finally {
        this.activeMutations -= 1;
      }
    };
    const current = this.mutationQueue.then(execute, execute);
    this.mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  }

  private async writeManifest(): Promise<void> {
    await assertNoSymlinkInPath(this.dataDirectory);
    await mkdir(this.dataDirectory, { recursive: true });
    const temporaryPath = `${this.manifestPath}.${randomUUID()}.tmp`;
    const contents: WorldManifest = { schemaVersion: MANIFEST_SCHEMA, worlds: this.records };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(contents, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.manifestPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureWorldsDirectory(): Promise<void> {
    await assertNoSymlinkInPath(this.serverDirectory);
    try {
      const info = await lstat(this.worldsDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorldManagerError('Le dossier worlds du serveur n’est pas sûr.', 409);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(this.worldsDirectory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.worldsDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WorldManagerError('Impossible de sécuriser le dossier worlds.', 409);
    }
  }

  async initialize(activeConfiguration: DeployConfiguration | null): Promise<void> {
    await this.withMutation(async () => {
      await assertNoSymlinkInPath(this.serverDirectory);
      await assertNoSymlinkInPath(this.dataDirectory);
      await mkdir(this.dataDirectory, { recursive: true });
      try {
        const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8')) as unknown;
        if (!isRecord(parsed) || parsed.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(parsed.worlds)) {
          throw new Error('Le registre des mondes est invalide ou utilise un schéma non pris en charge.');
        }
        this.records = parsed.worlds.map(parseStoredWorld);
        if (new Set(this.records.map((record) => record.id)).size !== this.records.length) {
          throw new Error('Le registre contient des identifiants de monde en double.');
        }
        if (new Set(this.records.map((record) => record.folder)).size !== this.records.length) {
          throw new Error('Le registre associe plusieurs mondes au même dossier.');
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        this.records = [];
      }

      let changed = false;
      try {
        const worldsInfo = await lstat(this.worldsDirectory);
        if (!worldsInfo.isDirectory() || worldsInfo.isSymbolicLink()) {
          throw new WorldManagerError('Le dossier worlds du serveur n’est pas sûr.', 409);
        }
        const entries = await readdir(this.worldsDirectory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const folder = entry.name;
          if (!isSafeFolderName(folder) || !await isWorldDirectory(path.join(this.worldsDirectory, folder))) continue;
          if (this.records.some((record) => record.folder === folder)) continue;
          const now = new Date().toISOString();
          const isActive = activeConfiguration?.levelName === folder;
          this.records.push({
            id: randomUUID(),
            name: folder,
            folder,
            version: isActive ? activeConfiguration.version : null,
            seed: isActive ? activeConfiguration.seed : null,
            configuration: isActive ? { ...activeConfiguration } : null,
            source: 'legacy',
            createdAt: now,
            updatedAt: now,
            lastUsedAt: isActive ? now : null,
          });
          changed = true;
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      if (changed || this.records.length === 0) await this.writeManifest();
    });
  }

  private getRecord(id: string): StoredWorld {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) throw new WorldManagerError('Monde introuvable.', 404);
    return record;
  }

  getWorld(id: string): StoredWorld {
    const record = this.getRecord(id);
    return { ...record, configuration: record.configuration ? { ...record.configuration, adminXuids: [...record.configuration.adminXuids] } : null };
  }

  findByVersionAndFolder(version: string, folder: string): StoredWorld | null {
    const record = this.records.find((candidate) => candidate.version === version && candidate.folder === folder);
    return record ? this.getWorld(record.id) : null;
  }

  async listWorlds(version?: string): Promise<ManagedWorld[]> {
    await assertNoSymlinkInPath(this.serverDirectory);
    const results: ManagedWorld[] = [];
    for (const record of [...this.records]) {
      if (version && record.version !== version) continue;
      const root = path.join(this.worldsDirectory, record.folder);
      let status: ManagedWorld['status'] = record.version ? 'missing' : 'unassigned';
      let sizeBytes: number | null = null;
      let lastModifiedAt: string | null = null;
      try {
        const rootInfo = await lstat(root);
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) status = 'unsafe';
        else {
          const [levelInfo, dbInfo] = await Promise.all([
            lstat(path.join(root, 'level.dat')).catch(() => null),
            lstat(path.join(root, 'db')).catch(() => null),
          ]);
          if (levelInfo?.isSymbolicLink() || dbInfo?.isSymbolicLink()) status = 'unsafe';
          else if (levelInfo?.isFile() && dbInfo?.isDirectory()) {
            status = record.version ? 'ready' : 'unassigned';
            lastModifiedAt = levelInfo.mtime.toISOString();
          } else {
            status = record.source === 'created' ? 'pending' : record.version ? 'missing' : 'unassigned';
          }
        }
      } catch (error) {
        if (!isMissing(error)) status = 'unsafe';
        else if (record.source === 'created') status = 'pending';
      }
      results.push({
        ...record,
        configuration: record.configuration ? { ...record.configuration, adminXuids: [...record.configuration.adminXuids] } : null,
        status,
        sizeBytes,
        lastModifiedAt,
      });
    }
    return results.sort((left, right) => {
      const leftTime = Date.parse(left.lastUsedAt ?? left.updatedAt);
      const rightTime = Date.parse(right.lastUsedAt ?? right.updatedAt);
      return rightTime - leftTime || left.name.localeCompare(right.name);
    });
  }

  private assertUniqueName(name: string, version: string, exceptId?: string): void {
    const exists = this.records.some((record) => record.id !== exceptId
      && record.version === version
      && record.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (exists) throw new WorldManagerError('Un monde de ce nom existe déjà pour cette version BDS.', 409);
  }

  private async createRecord(
    nameInput: unknown,
    version: string,
    seed: string,
    source: WorldSource,
    configuration: DeployConfiguration | null,
  ): Promise<StoredWorld> {
    const name = normalizeWorldName(nameInput);
    if (!WORLD_VERSION_PATTERN.test(version)) throw new WorldManagerError('Version BDS invalide.');
    this.assertUniqueName(name, version);
    const now = new Date().toISOString();
    let id = randomUUID();
    let folder = worldIdFolder(id);
    while (this.records.some((record) => record.id === id || record.folder === folder)) {
      id = randomUUID();
      folder = worldIdFolder(id);
    }
    const record: StoredWorld = {
      id,
      name,
      folder,
      version,
      seed,
      configuration: configuration ? { ...configuration, version, levelName: folder, seed, adminXuids: [...configuration.adminXuids] } : null,
      source,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    this.records.push(record);
    await this.writeManifest();
    return record;
  }

  async resolveForDeployment(configuration: DeployConfiguration, selection: WorldSelection): Promise<{ configuration: DeployConfiguration; worldId: string }> {
    return this.withMutation(async () => {
      await assertNoSymlinkInPath(this.serverDirectory);
      if (selection.mode === 'new') {
        const record = await this.createRecord(selection.name, configuration.version, configuration.seed, 'created', configuration);
        return {
          configuration: { ...configuration, levelName: record.folder },
          worldId: record.id,
        };
      }
      if (selection.mode !== 'existing' || typeof selection.id !== 'string') {
        throw new WorldManagerError('Choix de monde invalide.');
      }
      const record = this.getRecord(selection.id);
      if (record.version !== configuration.version) {
        throw new WorldManagerError('Ce monde appartient à une autre version BDS. Il ne peut pas être partagé entre versions.', 409);
      }
      const root = path.join(this.worldsDirectory, record.folder);
      if (!await isWorldDirectory(root)) throw new WorldManagerError('Ce monde est absent ou incomplet ; il ne peut pas être repris.', 409);
      await assertNoUnsafeEntries(root);
      if (record.seed !== null && configuration.seed !== record.seed) {
        throw new WorldManagerError('La seed d’un monde existant ne peut pas être modifiée. Crée un nouveau monde pour utiliser une autre seed.', 409);
      }
      if (record.seed === null && configuration.seed.trim() !== '') {
        throw new WorldManagerError('La seed de ce monde importé est inconnue et ne peut pas être changée. Crée un nouveau monde pour utiliser une seed.', 409);
      }
      const resolved = {
        ...configuration,
        levelName: record.folder,
        seed: record.seed ?? '',
      };
      record.configuration = { ...resolved, adminXuids: [...resolved.adminXuids] };
      record.updatedAt = new Date().toISOString();
      await this.writeManifest();
      return { configuration: resolved, worldId: record.id };
    });
  }

  async ensureActiveWorld(configuration: DeployConfiguration): Promise<void> {
    await this.withMutation(async () => {
      await assertNoSymlinkInPath(this.serverDirectory);
      if (!isSafeFolderName(configuration.levelName) || !WORLD_VERSION_PATTERN.test(configuration.version)) {
        throw new WorldManagerError('La configuration active ne référence pas un monde ou une version BDS sûre.', 409);
      }
      await this.ensureWorldsDirectory();
      const exact = this.records.find((record) => record.version === configuration.version && record.folder === configuration.levelName);
      if (exact) {
        const worldPath = path.join(this.worldsDirectory, exact.folder);
        const rootInfo = await lstat(worldPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (rootInfo?.isSymbolicLink() || (rootInfo && !rootInfo.isDirectory())) {
          throw new WorldManagerError('Le dossier du monde actif n’est pas sûr.', 409);
        }
        if (await isWorldDirectory(worldPath)) await assertNoUnsafeEntries(worldPath);
        else if (exact.source !== 'created') {
          throw new WorldManagerError('Le monde actif est absent ou incomplet. Choisis un monde prêt dans le gestionnaire.', 409);
        } else if (rootInfo && (await readdir(worldPath)).length > 0) {
          throw new WorldManagerError('Le dossier du nouveau monde contient déjà des fichiers inattendus; il ne sera pas écrasé.', 409);
        }
        return;
      }
      if (this.records.some((record) => record.folder === configuration.levelName && record.version !== configuration.version)) {
        throw new WorldManagerError('Ce dossier de monde est déjà dédié à une autre version BDS; aucune sauvegarde ne sera partagée.', 409);
      }

      const worldPath = path.join(this.worldsDirectory, configuration.levelName);
      const rootInfo = await lstat(worldPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (rootInfo?.isSymbolicLink() || (rootInfo && !rootInfo.isDirectory())) {
        throw new WorldManagerError('Le dossier de monde actif n’est pas sûr.', 409);
      }
      const existingWorldReady = Boolean(rootInfo && await isWorldDirectory(worldPath));
      if (existingWorldReady) await assertNoUnsafeEntries(worldPath);
      else if (rootInfo && (await readdir(worldPath)).length > 0) {
        throw new WorldManagerError('Le dossier actif existe mais ne contient pas un monde Bedrock complet; il ne sera pas écrasé.', 409);
      }

      let name = configuration.levelName;
      let suffix = 2;
      while (this.records.some((record) => record.version === configuration.version && record.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        name = `${configuration.levelName} (${suffix})`;
        suffix += 1;
      }
      const now = new Date().toISOString();
      this.records.push({
        id: randomUUID(),
        name,
        folder: configuration.levelName,
        version: configuration.version,
        seed: configuration.seed,
        configuration: { ...configuration, adminXuids: [...configuration.adminXuids] },
        source: existingWorldReady ? 'legacy' : 'created',
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      });
      await this.writeManifest();
    });
  }

  async updateConfiguration(id: string, configuration: DeployConfiguration): Promise<void> {
    await this.withMutation(async () => {
      const record = this.getRecord(id);
      if (record.version !== configuration.version) {
        throw new WorldManagerError('Les réglages ne correspondent pas à la version exacte de ce monde.', 409);
      }
      if (record.seed !== null && record.seed !== configuration.seed) {
        throw new WorldManagerError('La seed d’un monde existant ne peut pas être modifiée. Crée un nouveau monde.', 409);
      }
      if (record.seed === null && configuration.seed !== '') {
        throw new WorldManagerError('La seed d’un monde importé est inconnue et ne peut pas être modifiée.', 409);
      }
      record.configuration = { ...configuration, levelName: record.folder, seed: record.seed ?? '', adminXuids: [...configuration.adminXuids] };
      record.updatedAt = new Date().toISOString();
      await this.writeManifest();
    });
  }

  async updateActiveConfiguration(configuration: DeployConfiguration): Promise<void> {
    const record = this.findByVersionAndFolder(configuration.version, configuration.levelName);
    if (!record) return;
    await this.updateConfiguration(record.id, configuration);
  }

  async renameWorld(id: string, nameInput: unknown): Promise<ManagedWorld> {
    return this.withMutation(async () => {
      const record = this.getRecord(id);
      const name = normalizeWorldName(nameInput);
      if (record.version) this.assertUniqueName(name, record.version, id);
      else if (this.records.some((candidate) => candidate.id !== id && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new WorldManagerError('Un monde de ce nom existe déjà.', 409);
      }
      record.name = name;
      record.updatedAt = new Date().toISOString();
      await this.writeManifest();
      return (await this.listWorlds()).find((world) => world.id === id)!;
    });
  }

  async assignVersion(id: string, version: string): Promise<ManagedWorld> {
    return this.withMutation(async () => {
      await assertNoSymlinkInPath(this.serverDirectory);
      const record = this.getRecord(id);
      if (!WORLD_VERSION_PATTERN.test(version)) throw new WorldManagerError('Version BDS invalide.');
      if (record.version && record.version !== version) {
        throw new WorldManagerError('La version d’un monde déjà attribué ne peut pas être changée. Importe ou crée un autre monde pour une version différente.', 409);
      }
      if (!await isWorldDirectory(path.join(this.worldsDirectory, record.folder))) {
        throw new WorldManagerError('Seul un monde Bedrock complet peut être associé à une version.', 409);
      }
      record.version = version;
      record.configuration = record.configuration ? { ...record.configuration, version, levelName: record.folder } : null;
      record.updatedAt = new Date().toISOString();
      await this.writeManifest();
      return (await this.listWorlds()).find((world) => world.id === id)!;
    });
  }

  async markUsedByConfiguration(configuration: DeployConfiguration): Promise<void> {
    await this.withMutation(async () => {
      const record = this.records.find((candidate) => candidate.version === configuration.version && candidate.folder === configuration.levelName);
      if (!record) return;
      const now = new Date().toISOString();
      record.lastUsedAt = now;
      record.updatedAt = now;
      record.configuration = { ...configuration, adminXuids: [...configuration.adminXuids] };
      await this.writeManifest();
    });
  }

  async deleteWorld(id: string, confirmation: unknown): Promise<StoredWorld> {
    return this.withMutation(async () => {
      const record = this.getRecord(id);
      if (typeof confirmation !== 'string' || confirmation !== record.name) {
        throw new WorldManagerError('Confirmation refusée : saisis le nom exact du monde pour le supprimer.', 409);
      }
      await this.ensureWorldsDirectory();
      const target = path.join(this.worldsDirectory, record.folder);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new WorldManagerError('Suppression refusée : le dossier du monde n’est pas sûr.', 409);
        await assertNoUnsafeEntries(target);
        await rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      this.records = this.records.filter((candidate) => candidate.id !== record.id);
      await this.writeManifest();
      return { ...record };
    });
  }

  async importArchive(
    archivePath: string,
    nameInput: unknown,
    version: string,
    baseConfiguration: DeployConfiguration | null,
  ): Promise<ManagedWorld> {
    return this.withMutation(async () => {
      const name = normalizeWorldName(nameInput);
      if (!WORLD_VERSION_PATTERN.test(version)) throw new WorldManagerError('Version BDS invalide.');
      this.assertUniqueName(name, version);
      const importId = randomUUID();
      const extractionDirectory = path.join(this.dataDirectory, `.world-import-${importId}`);
      const stagingDirectory = path.join(this.worldsDirectory, `.world-import-${importId}`);
      let destination: string | null = null;
      try {
        await extractZipSafely(archivePath, extractionDirectory);
        const sourceWorld = await findWorldRoot(extractionDirectory);
        await this.ensureWorldsDirectory();
        await copyWorldTree(sourceWorld, stagingDirectory);
        if (!await isWorldDirectory(stagingDirectory)) throw new WorldManagerError('Le monde importé est incomplet.');

        let id = randomUUID();
        let folder = worldIdFolder(id);
        while (this.records.some((record) => record.id === id || record.folder === folder)) {
          id = randomUUID();
          folder = worldIdFolder(id);
        }
        destination = path.join(this.worldsDirectory, folder);
        await rename(stagingDirectory, destination);
        const now = new Date().toISOString();
        const configuration = baseConfiguration
          ? { ...baseConfiguration, version, levelName: folder, seed: '', adminXuids: [...baseConfiguration.adminXuids] }
          : null;
        const record: StoredWorld = {
          id,
          name,
          folder,
          version,
          seed: null,
          configuration,
          source: 'imported',
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };
        this.records.push(record);
        try {
          await this.writeManifest();
        } catch (error) {
          this.records = this.records.filter((candidate) => candidate.id !== id);
          await rm(destination, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        return (await this.listWorlds()).find((world) => world.id === id)!;
      } finally {
        await rm(extractionDirectory, { recursive: true, force: true }).catch(() => undefined);
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        if (destination && !this.records.some((record) => record.folder === path.basename(destination!))) {
          await rm(destination, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    });
  }

  async createWorldArchive(id: string): Promise<{ fileName: string; stream: Readable }> {
    if (this.isBusy) {
      throw new WorldManagerError('Une autre opération protège actuellement les mondes.', 409);
    }
    this.activeOperations += 1;
    let lockHeld = true;
    const releaseLock = () => {
      if (!lockHeld) return;
      lockHeld = false;
      this.activeOperations -= 1;
    };

    try {
      await assertNoSymlinkInPath(this.serverDirectory);
      const record = this.getRecord(id);
      const worldDirectory = path.join(this.worldsDirectory, record.folder);
      if (!await isWorldDirectory(worldDirectory)) throw new WorldManagerError('Ce monde est absent ou incomplet et ne peut pas être exporté.', 409);
      await assertNoUnsafeEntries(worldDirectory);

      const zip = new yazl.ZipFile();
      const output = new PassThrough();
      output.once('close', releaseLock);
      output.once('end', releaseLock);
      output.once('error', releaseLock);
      zip.outputStream.on('error', (error) => output.destroy(error));
      zip.outputStream.pipe(output);

      const stack: Array<{ absolute: string; relative: string }> = [{ absolute: worldDirectory, relative: '' }];
      let entryCount = 0;
      try {
        while (stack.length > 0) {
          const current = stack.pop()!;
          const entries = await readdir(current.absolute, { withFileTypes: true });
          for (const entry of entries) {
            entryCount += 1;
            if (entryCount > MAX_TREE_ENTRIES) throw new WorldManagerError('Le monde contient trop de fichiers à exporter.', 413);
            const absolute = path.join(current.absolute, entry.name);
            const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
            const info = await lstat(absolute);
            if (info.isSymbolicLink()) throw new WorldManagerError('Export refusé : le monde contient un lien symbolique.', 409);
            if (info.isDirectory()) stack.push({ absolute, relative });
            else if (info.isFile()) zip.addFile(absolute, relative, { mtime: info.mtime, mode: 0o100600, compress: true });
            else throw new WorldManagerError('Export refusé : le monde contient un type de fichier non pris en charge.', 409);
          }
        }
        zip.end();
      } catch (error) {
        output.destroy(error as Error);
        throw error;
      }
      return { fileName: archiveName(record.name, record.version), stream: output };
    } catch (error) {
      releaseLock();
      throw error;
    }
  }
}
