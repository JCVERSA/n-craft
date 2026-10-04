import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BedrockPackDependency,
  BedrockPackKind,
  BedrockPackVersion,
  ManagedBedrockPack,
  WorldBedrockPacksSnapshot,
} from '../types/backend.ts';
import { extractZipSafely } from './extractArchive.ts';
import type { WorldManager } from './worldManager.ts';

const PACK_ROOTS: Record<BedrockPackKind, string> = {
  resource: 'resource_packs',
  behavior: 'behavior_packs',
};
const UUID_PATTERN = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const MAX_PACK_ARCHIVE_ENTRIES = 10_000;
const MAX_PACK_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_PACK_MANIFEST_SEARCH_DEPTH = 32;
const MAX_PACK_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORLD_PACK_LIST_BYTES = 16 * 1024 * 1024;
export const MAX_PACK_ARCHIVE_BYTES = 256 * 1024 * 1024;

interface PackManifestData {
  uuid: string;
  name: string;
  description: string;
  kind: BedrockPackKind;
  version: BedrockPackVersion;
  dependencies: BedrockPackDependency[];
  directory: string;
}

interface InstalledPack extends PackManifestData {}

interface ActivationEntry {
  pack_id: string;
  version: BedrockPackVersion;
  [key: string]: unknown;
}

export class BedrockPackManagerError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'BedrockPackManagerError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function parseVersion(value: unknown): BedrockPackVersion | null {
  if (!Array.isArray(value) || value.length !== 3
    || !value.every((part) => Number.isSafeInteger(part) && part >= 0 && part <= 2_147_483_647)) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function parseModuleName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 && /^[A-Za-z0-9@._:/-]+$/.test(normalized)
    ? normalized
    : null;
}

function parseModuleDependencyVersion(value: unknown): string | null {
  if (typeof value === 'string') return /^\d[\dA-Za-z.+-]{0,63}$/.test(value) ? value : null;
  return parseVersion(value)?.join('.') ?? null;
}

function cleanManifestText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function sameVersion(left: BedrockPackVersion, right: BedrockPackVersion): boolean {
  return left.every((part, index) => part === right[index]);
}

async function assertNoSymlinkInPath(filePath: string): Promise<void> {
  let current = path.resolve(filePath);
  while (true) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      throw new BedrockPackManagerError(`Opération refusée : le chemin ${current} contient un lien symbolique.`, 409);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertArchiveFileSafe(archivePath: string): Promise<void> {
  const absolutePath = path.resolve(archivePath);
  await assertNoSymlinkInPath(absolutePath);
  const info = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size === 0) {
    throw new BedrockPackManagerError('L’archive importée est absente, vide ou n’est pas un fichier normal.');
  }
  if (info.size > MAX_PACK_ARCHIVE_BYTES) {
    throw new BedrockPackManagerError('Archive de pack trop volumineuse (limite : 256 Mio).', 413);
  }
}

async function readManifest(directory: string): Promise<Omit<PackManifestData, 'directory'>> {
  const manifestPath = path.join(directory, 'manifest.json');
  await assertNoSymlinkInPath(manifestPath);
  const info = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size > MAX_PACK_MANIFEST_BYTES) {
    throw new BedrockPackManagerError('Le pack doit contenir un manifest.json normal de taille raisonnable.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch {
    throw new BedrockPackManagerError('Le manifest.json du pack est invalide.');
  }
  if (!isRecord(parsed) || !isRecord(parsed.header) || !Array.isArray(parsed.modules)) {
    throw new BedrockPackManagerError('Le manifest.json ne décrit pas un pack Bedrock valide.');
  }
  if (parsed.format_version !== 1 && parsed.format_version !== 2) {
    throw new BedrockPackManagerError('Version de format du manifest Bedrock non prise en charge.');
  }

  const uuid = parseUuid(parsed.header.uuid);
  const version = parseVersion(parsed.header.version);
  const name = cleanManifestText(parsed.header.name, 100);
  if (!uuid || !version || !name || parsed.modules.length === 0 || parsed.modules.length > 32) {
    throw new BedrockPackManagerError('Le manifest doit contenir un nom, un UUID, une version et des modules valides.');
  }

  const kinds = new Set<BedrockPackKind>();
  const moduleUuids = new Set([uuid]);
  for (const module of parsed.modules) {
    const moduleUuid = isRecord(module) ? parseUuid(module.uuid) : null;
    if (!isRecord(module) || !moduleUuid || !parseVersion(module.version) || typeof module.type !== 'string') {
      throw new BedrockPackManagerError('Un module du manifest ne contient pas d’UUID, de version ou de type valide.');
    }
    if (moduleUuids.has(moduleUuid)) {
      throw new BedrockPackManagerError('Les UUID du pack et de ses modules doivent être uniques.');
    }
    moduleUuids.add(moduleUuid);
    if (module.type === 'resources') kinds.add('resource');
    else if (module.type === 'data' || module.type === 'script') kinds.add('behavior');
    else throw new BedrockPackManagerError(`Type de module Bedrock non pris en charge : ${module.type}.`);
  }
  if (kinds.size !== 1) {
    throw new BedrockPackManagerError('Un fichier importé doit décrire un seul pack de ressources ou de comportement.');
  }

  const dependencies: BedrockPackDependency[] = [];
  if (parsed.dependencies !== undefined && parsed.dependencies !== null) {
    if (!Array.isArray(parsed.dependencies) || parsed.dependencies.length > 64) {
      throw new BedrockPackManagerError('La liste de dépendances du pack est invalide ou trop longue.');
    }
    const packDependencyIds = new Set<string>();
    const moduleDependencyNames = new Set<string>();
    for (const dependency of parsed.dependencies) {
      if (!isRecord(dependency)) throw new BedrockPackManagerError('Une dépendance du pack est invalide.');
      const hasPackUuid = Object.prototype.hasOwnProperty.call(dependency, 'uuid');
      const hasModuleName = Object.prototype.hasOwnProperty.call(dependency, 'module_name');
      if (hasPackUuid === hasModuleName) {
        throw new BedrockPackManagerError('Une dépendance doit cibler un pack UUID ou un module Bedrock, mais pas les deux.');
      }

      if (hasPackUuid) {
        const dependencyUuid = parseUuid(dependency.uuid);
        const dependencyVersion = parseVersion(dependency.version);
        if (!dependencyUuid || !dependencyVersion || moduleUuids.has(dependencyUuid)) {
          throw new BedrockPackManagerError('Une dépendance de pack contient un UUID ou une version invalide.');
        }
        if (packDependencyIds.has(dependencyUuid)) {
          throw new BedrockPackManagerError('Le manifest contient une dépendance en double.');
        }
        packDependencyIds.add(dependencyUuid);
        dependencies.push({ type: 'pack', uuid: dependencyUuid, version: dependencyVersion });
        continue;
      }

      const moduleName = parseModuleName(dependency.module_name);
      const moduleVersion = parseModuleDependencyVersion(dependency.version);
      if (!moduleName || !moduleVersion) {
        throw new BedrockPackManagerError('Une dépendance de module Bedrock contient un nom ou une version invalide.');
      }
      const normalizedModuleName = moduleName.toLowerCase();
      if (moduleDependencyNames.has(normalizedModuleName)) {
        throw new BedrockPackManagerError('Le manifest contient une dépendance de module en double.');
      }
      moduleDependencyNames.add(normalizedModuleName);
      dependencies.push({ type: 'module', moduleName, version: moduleVersion });
    }
  }

  const description = cleanManifestText(parsed.header.description, 240);
  return { uuid, name, description, kind: [...kinds][0]!, version, dependencies };
}

export class BedrockPackManager {
  constructor(private readonly worlds: WorldManager) {}

  async listForWorld(worldId: string): Promise<WorldBedrockPacksSnapshot> {
    return this.worlds.withExclusiveOperation(async () => this.listForWorldUnlocked(worldId));
  }

  async importArchive(archivePath: string): Promise<ManagedBedrockPack> {
    const serverDirectory = this.worlds.serverDirectoryPath;
    const importDirectory = path.join(serverDirectory, `.ncraft-pack-import-${randomUUID()}`);
    let stagingDirectory: string | null = null;
    let installedDirectory: string | null = null;

    try {
      return await this.worlds.withExclusiveOperation(async () => {
        await this.ensureServerDirectory();
        await assertArchiveFileSafe(archivePath);
        await extractZipSafely(archivePath, importDirectory, undefined, {
          maxEntries: MAX_PACK_ARCHIVE_ENTRIES,
          maxUnpackedBytes: MAX_PACK_UNPACKED_BYTES,
        });
        const manifestDirectories = await this.findManifestDirectories(importDirectory);
        if (manifestDirectories.length === 0) {
          throw new BedrockPackManagerError('Aucun manifest.json de pack Bedrock n’a été trouvé dans l’archive.');
        }
        if (manifestDirectories.length > 1) {
          throw new BedrockPackManagerError('Cette archive contient plusieurs packs. Importe un fichier .mcpack ou un ZIP avec un seul manifest à la fois.');
        }

        const packDirectory = manifestDirectories[0]!;
        const manifest = await readManifest(packDirectory);
        const installed = await this.listInstalledPacks();
        if (installed.some((pack) => pack.uuid === manifest.uuid)) {
          throw new BedrockPackManagerError('Un pack avec cet UUID est déjà installé; aucun fichier existant n’a été remplacé.', 409);
        }

        const root = await this.ensurePackRoot(manifest.kind);
        const target = path.join(root, `ncraft-${manifest.uuid}`);
        if (await this.pathExists(target)) {
          throw new BedrockPackManagerError('Le dossier cible existe déjà; aucun fichier n’a été remplacé.', 409);
        }
        stagingDirectory = path.join(root, `.ncraft-stage-${randomUUID()}`);
        await this.hardenTree(packDirectory);
        await rename(packDirectory, stagingDirectory);
        await rename(stagingDirectory, target);
        stagingDirectory = null;
        installedDirectory = target;

        return {
          uuid: manifest.uuid,
          name: manifest.name,
          description: manifest.description,
          kind: manifest.kind,
          version: manifest.version,
          dependencies: manifest.dependencies,
          active: false,
        };
      });
    } catch (error) {
      if (installedDirectory) await rm(installedDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(importDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async setActive(worldId: string, rawUuid: unknown, enabled: boolean): Promise<WorldBedrockPacksSnapshot> {
    const uuid = parseUuid(rawUuid);
    if (!uuid) throw new BedrockPackManagerError('UUID de pack invalide.');
    if (typeof enabled !== 'boolean') throw new BedrockPackManagerError('L’état d’activation doit être vrai ou faux.');

    return this.worlds.withExclusiveOperation(async () => {
      const { directory: worldDirectory } = await this.getReadyWorld(worldId);
      const packs = await this.listInstalledPacks();
      const pack = packs.find((candidate) => candidate.uuid === uuid);
      if (!pack) throw new BedrockPackManagerError('Pack introuvable dans les dossiers Bedrock.', 404);

      const resourcePath = path.join(worldDirectory, 'world_resource_packs.json');
      const behaviorPath = path.join(worldDirectory, 'world_behavior_packs.json');
      const resourceEntries = await this.readActivationEntries(resourcePath);
      const behaviorEntries = await this.readActivationEntries(behaviorPath);
      const selectedEntries = pack.kind === 'resource' ? resourceEntries : behaviorEntries;
      const index = selectedEntries.findIndex((entry) => entry.pack_id === pack.uuid);

      if (enabled) {
        await this.assertDependenciesActive(pack, packs, resourceEntries, behaviorEntries);
        if (index < 0) selectedEntries.push({ pack_id: pack.uuid, version: pack.version });
        else selectedEntries[index] = { ...selectedEntries[index]!, pack_id: pack.uuid, version: pack.version };
      } else if (index >= 0) {
        const activeIds = new Set([...resourceEntries, ...behaviorEntries].map((entry) => entry.pack_id));
        const dependents = packs.filter((candidate) => activeIds.has(candidate.uuid)
          && candidate.uuid !== pack.uuid
          && candidate.dependencies.some((dependency) => dependency.type === 'pack' && dependency.uuid === pack.uuid));
        if (dependents.length) {
          throw new BedrockPackManagerError(`Désactive d’abord le pack dépendant « ${dependents[0]!.name} ».`, 409);
        }
        selectedEntries.splice(index, 1);
      }

      if (enabled || index >= 0) {
        const selectedPath = pack.kind === 'resource' ? resourcePath : behaviorPath;
        await this.writeActivationEntries(selectedPath, selectedEntries);
      }
      return this.listForWorldUnlocked(worldId);
    });
  }

  private async listForWorldUnlocked(worldId: string): Promise<WorldBedrockPacksSnapshot> {
    const { world, directory } = await this.getReadyWorld(worldId);
    const [packs, resources, behaviors] = await Promise.all([
      this.listInstalledPacks(),
      this.readActivationEntries(path.join(directory, 'world_resource_packs.json')),
      this.readActivationEntries(path.join(directory, 'world_behavior_packs.json')),
    ]);
    return {
      worldId: world.id,
      worldName: world.name,
      packs: packs.map((pack) => ({
        uuid: pack.uuid,
        name: pack.name,
        description: pack.description,
        kind: pack.kind,
        version: pack.version,
        dependencies: pack.dependencies,
        active: (pack.kind === 'resource' ? resources : behaviors)
          .some((entry) => entry.pack_id === pack.uuid && sameVersion(entry.version, pack.version)),
      })),
    };
  }

  private async assertDependenciesActive(
    pack: InstalledPack,
    installed: InstalledPack[],
    resourceEntries: ActivationEntry[],
    behaviorEntries: ActivationEntry[],
  ): Promise<void> {
    for (const dependency of pack.dependencies) {
      if (dependency.type !== 'pack') continue;
      const installedDependency = installed.find((candidate) => candidate.uuid === dependency.uuid);
      if (!installedDependency) {
        throw new BedrockPackManagerError(`Dépendance manquante pour « ${pack.name} » : ${dependency.uuid}.`, 409);
      }
      if (!sameVersion(installedDependency.version, dependency.version)) {
        throw new BedrockPackManagerError(`La version installée de « ${installedDependency.name} » ne correspond pas à la dépendance de « ${pack.name} ».`, 409);
      }
      const activeEntries = installedDependency.kind === 'resource' ? resourceEntries : behaviorEntries;
      if (!activeEntries.some((entry) => entry.pack_id === dependency.uuid && sameVersion(entry.version, dependency.version))) {
        throw new BedrockPackManagerError(`Active d’abord la dépendance « ${installedDependency.name} » avec la version requise.`, 409);
      }
    }
  }

  private async listInstalledPacks(): Promise<InstalledPack[]> {
    const packs: InstalledPack[] = [];
    for (const kind of ['resource', 'behavior'] as const) {
      const root = await this.getPackRoot(kind);
      if (!root) continue;
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new BedrockPackManagerError(`Le dossier ${PACK_ROOTS[kind]} contient un lien symbolique.`, 409);
        }
        if (!entry.isDirectory()) continue;
        const directory = path.join(root, entry.name);
        let manifest: Omit<PackManifestData, 'directory'>;
        try {
          manifest = await readManifest(directory);
        } catch (error) {
          if (error instanceof BedrockPackManagerError && /lien symbolique/.test(error.message)) throw error;
          // Official or custom folders without a usable pack manifest are left untouched.
          continue;
        }
        if (manifest.kind !== kind) {
          throw new BedrockPackManagerError(`Le pack « ${manifest.name} » est rangé dans le mauvais dossier ${PACK_ROOTS[kind]}.`, 409);
        }
        packs.push({ ...manifest, directory });
      }
    }

    const seen = new Set<string>();
    for (const pack of packs) {
      if (seen.has(pack.uuid)) {
        throw new BedrockPackManagerError(`Plusieurs packs installés partagent l’UUID ${pack.uuid}; corrige ce doublon avant de modifier le monde.`, 409);
      }
      seen.add(pack.uuid);
    }
    return packs.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async getReadyWorld(worldId: string): Promise<{ world: ReturnType<WorldManager['getWorld']>; directory: string }> {
    const world = this.worlds.getWorld(worldId);
    if (!world.version) {
      throw new BedrockPackManagerError('Associe ce monde à une version BDS avant de gérer ses packs.', 409);
    }
    const directory = path.join(this.worlds.worldsDirectory, world.folder);
    await assertNoSymlinkInPath(directory);
    const rootInfo = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new BedrockPackManagerError('Le monde est absent ou son dossier n’est pas sûr.', 409);
    }
    const [levelInfo, databaseInfo] = await Promise.all([
      lstat(path.join(directory, 'level.dat')).catch((error: NodeJS.ErrnoException) => isMissing(error) ? null : Promise.reject(error)),
      lstat(path.join(directory, 'db')).catch((error: NodeJS.ErrnoException) => isMissing(error) ? null : Promise.reject(error)),
    ]);
    if (!levelInfo?.isFile() || levelInfo.isSymbolicLink() || !databaseInfo?.isDirectory() || databaseInfo.isSymbolicLink()) {
      throw new BedrockPackManagerError('Seul un monde Bedrock complet peut recevoir des packs.', 409);
    }
    return { world, directory };
  }

  private async readActivationEntries(filePath: string): Promise<ActivationEntry[]> {
    await assertNoSymlinkInPath(filePath);
    const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return [];
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_WORLD_PACK_LIST_BYTES) {
      throw new BedrockPackManagerError(`Le fichier ${path.basename(filePath)} n’est pas sûr ou dépasse la taille autorisée.`, 409);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    } catch {
      throw new BedrockPackManagerError(`Le fichier ${path.basename(filePath)} est illisible ou invalide.`, 409);
    }
    if (!Array.isArray(parsed) || parsed.length > 10_000) {
      throw new BedrockPackManagerError(`Le fichier ${path.basename(filePath)} doit contenir une liste de packs de taille raisonnable.`, 409);
    }

    const entries = parsed.map((value) => {
      if (!isRecord(value)) throw new BedrockPackManagerError(`Le fichier ${path.basename(filePath)} contient une entrée de pack invalide.`, 409);
      const uuid = parseUuid(value.pack_id);
      const version = parseVersion(value.version);
      if (!uuid || !version) {
        throw new BedrockPackManagerError(`Le fichier ${path.basename(filePath)} contient un UUID ou une version invalide.`, 409);
      }
      return { ...value, pack_id: uuid, version };
    });
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.pack_id)) {
        throw new BedrockPackManagerError(`Le fichier ${path.basename(filePath)} contient un pack en double.`, 409);
      }
      seen.add(entry.pack_id);
    }
    return entries;
  }

  private async writeActivationEntries(filePath: string, entries: ActivationEntry[]): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async findManifestDirectories(rootDirectory: string): Promise<string[]> {
    const stack: Array<{ directory: string; depth: number }> = [{ directory: rootDirectory, depth: 0 }];
    const manifests: string[] = [];
    let entriesScanned = 0;
    while (stack.length) {
      const current = stack.pop()!;
      const entries = await readdir(current.directory, { withFileTypes: true });
      for (const entry of entries) {
        entriesScanned += 1;
        if (entriesScanned > MAX_PACK_ARCHIVE_ENTRIES) {
          throw new BedrockPackManagerError('Archive refusée : nombre d’entrées excessif.', 413);
        }
        if (entry.isSymbolicLink()) throw new BedrockPackManagerError('Archive refusée : lien symbolique inattendu.');
        const fullPath = path.join(current.directory, entry.name);
        if (entry.name === 'manifest.json' && entry.isFile()) manifests.push(current.directory);
        else if (entry.isDirectory()) {
          if (current.depth >= MAX_PACK_MANIFEST_SEARCH_DEPTH) {
            throw new BedrockPackManagerError('Archive refusée : arborescence de pack trop profonde.', 413);
          }
          stack.push({ directory: fullPath, depth: current.depth + 1 });
        } else if (!entry.isFile()) {
          throw new BedrockPackManagerError('Archive refusée : type de fichier non pris en charge.');
        }
      }
    }
    return manifests;
  }

  private async hardenTree(rootDirectory: string): Promise<void> {
    const info = await lstat(rootDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BedrockPackManagerError('Le dossier temporaire du pack n’est pas sûr.', 409);
    await chmod(rootDirectory, 0o700);
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDirectory, entry.name);
      const childInfo = await lstat(fullPath);
      if (childInfo.isSymbolicLink()) throw new BedrockPackManagerError('Pack refusé : lien symbolique inattendu.');
      if (childInfo.isDirectory()) await this.hardenTree(fullPath);
      else if (childInfo.isFile()) await chmod(fullPath, 0o600);
      else throw new BedrockPackManagerError('Pack refusé : type de fichier non pris en charge.');
    }
  }

  private async ensureServerDirectory(): Promise<void> {
    const directory = this.worlds.serverDirectoryPath;
    await assertNoSymlinkInPath(directory);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw new BedrockPackManagerError('Le dossier du serveur Bedrock est absent ou non sécurisé.', 409);
    }
  }

  private async ensurePackRoot(kind: BedrockPackKind): Promise<string> {
    await this.ensureServerDirectory();
    const root = path.join(this.worlds.serverDirectoryPath, PACK_ROOTS[kind]);
    await assertNoSymlinkInPath(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new BedrockPackManagerError(`Le dossier ${PACK_ROOTS[kind]} n’est pas sûr.`, 409);
    }
    return root;
  }

  private async getPackRoot(kind: BedrockPackKind): Promise<string | null> {
    const root = path.join(this.worlds.serverDirectoryPath, PACK_ROOTS[kind]);
    await assertNoSymlinkInPath(root);
    const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new BedrockPackManagerError(`Le dossier ${PACK_ROOTS[kind]} n’est pas sûr.`, 409);
    }
    return root;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return info !== null;
  }
}
