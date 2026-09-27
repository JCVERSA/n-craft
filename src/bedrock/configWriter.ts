import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DeployConfiguration } from '../types/backend.ts';

const GAME_MODES = new Set(['survival', 'creative', 'adventure']);
const DIFFICULTIES = new Set(['peaceful', 'easy', 'normal', 'hard']);

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ConfigurationError(`${label} est obligatoire.`);
  const normalized = value.trim();
  if (!normalized) throw new ConfigurationError(`${label} est obligatoire.`);
  if (normalized.length > maxLength) {
    throw new ConfigurationError(`${label} ne peut pas dépasser ${maxLength} caractères.`);
  }
  if (/[\r\n\0]/.test(normalized)) {
    throw new ConfigurationError(`${label} contient un caractère interdit.`);
  }
  return normalized;
}

function optionalSeed(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new ConfigurationError('La seed doit être du texte.');
  const normalized = value.trim();
  if (normalized.length > 80 || /[\r\n\0]/.test(normalized)) {
    throw new ConfigurationError('La seed est trop longue ou contient un caractère interdit.');
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${label} doit être un entier positif.`);
  }
  return parsed;
}

/** Validate all browser input again on the server; never trust disabled UI controls. */
export function validateDeployConfiguration(input: unknown, allowedVersions: ReadonlySet<string>): DeployConfiguration {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigurationError('Configuration de déploiement invalide.');
  }
  const raw = input as Record<string, unknown>;
  const version = requiredString(raw.version, 'Version', 40);
  if (!allowedVersions.has(version)) {
    throw new ConfigurationError('Cette version ne figure pas dans le catalogue déployable.');
  }

  const serverName = requiredString(raw.serverName, 'Nom du serveur', 64);
  const levelName = requiredString(raw.levelName, 'Nom du monde', 64);
  if (levelName === '.' || levelName === '..' || /[\\/]/.test(levelName) || /^[A-Za-z]:/.test(levelName)) {
    throw new ConfigurationError('Le nom du monde ne peut pas contenir de séparateur ou de chemin relatif.');
  }
  if (typeof raw.gamemode !== 'string' || !GAME_MODES.has(raw.gamemode)) {
    throw new ConfigurationError('Mode de jeu invalide.');
  }
  if (typeof raw.difficulty !== 'string' || !DIFFICULTIES.has(raw.difficulty)) {
    throw new ConfigurationError('Difficulté invalide.');
  }

  const maxPlayers = positiveInteger(raw.maxPlayers, 'Joueurs max', 10);
  const viewDistance = positiveInteger(raw.viewDistance, 'Distance de vue', 10);
  if (viewDistance > 96) throw new ConfigurationError('La distance de vue ne peut pas dépasser 96.');

  if (!Array.isArray(raw.adminXuids) || raw.adminXuids.length < 1 || raw.adminXuids.length > 3) {
    throw new ConfigurationError('Il faut fournir de 1 à 3 XUID administrateur.');
  }
  const adminXuids = raw.adminXuids.map((entry, index) => {
    if (typeof entry !== 'string' || !/^\d{1,20}$/.test(entry)) {
      throw new ConfigurationError(`Le XUID administrateur #${index + 1} doit contenir uniquement des chiffres, sans espace ni gamertag.`);
    }
    return entry;
  });
  if (new Set(adminXuids).size !== adminXuids.length) {
    throw new ConfigurationError('Les XUID administrateur doivent être uniques.');
  }

  if (typeof raw.allowCheats !== 'boolean' && raw.allowCheats !== undefined) {
    throw new ConfigurationError('Le réglage allow-cheats doit être vrai ou faux.');
  }
  if (raw.eulaAccepted !== true) {
    throw new ConfigurationError('Confirme d’abord avoir lu et accepté l’EULA Minecraft.');
  }

  return {
    version,
    serverName,
    levelName,
    gamemode: raw.gamemode as DeployConfiguration['gamemode'],
    difficulty: raw.difficulty as DeployConfiguration['difficulty'],
    maxPlayers,
    adminXuids,
    seed: optionalSeed(raw.seed),
    viewDistance,
    allowCheats: raw.allowCheats === true,
    eulaAccepted: true,
  };
}

/**
 * Writes initial settings, or fills only missing files when preserving an existing
 * server. Network ports, online-mode and allow-list remain application-controlled.
 */
export async function writeBedrockConfiguration(
  serverDirectory: string,
  configuration: DeployConfiguration,
  options: { preserveExisting?: boolean } = {},
): Promise<void> {
  await mkdir(serverDirectory, { recursive: true });

  const properties = [
    `server-name=${configuration.serverName}`,
    `level-name=${configuration.levelName}`,
    `gamemode=${configuration.gamemode}`,
    `difficulty=${configuration.difficulty}`,
    `max-players=${configuration.maxPlayers}`,
    `level-seed=${configuration.seed}`,
    `view-distance=${configuration.viewDistance}`,
    `allow-cheats=${configuration.allowCheats}`,
    'server-port=19132',
    'server-portv6=19133',
    'online-mode=false',
    'allow-list=false',
  ].join('\n') + '\n';

  const permissions = configuration.adminXuids.map((xuid) => ({
    permission: 'operator',
    xuid,
  }));

  await writeConfigurationFile(path.join(serverDirectory, 'server.properties'), properties, options.preserveExisting === true);
  await writeConfigurationFile(
    path.join(serverDirectory, 'permissions.json'),
    `${JSON.stringify(permissions, null, 2)}\n`,
    options.preserveExisting === true,
  );

  if (!options.preserveExisting) {
    // On a fresh server, an archive-provided default allowlist must not turn on
    // access restrictions contrary to the confirmed open-server setup.
    await Promise.all([
      rm(path.join(serverDirectory, 'allowlist.json'), { force: true }),
      rm(path.join(serverDirectory, 'whitelist.json'), { force: true }),
    ]);
  }
}

/** Apply operator-requested changes while preserving every unrelated property and permission. */
export async function updateBedrockConfiguration(
  serverDirectory: string,
  previous: DeployConfiguration,
  next: DeployConfiguration,
): Promise<void> {
  const propertyUpdates = new Map<string, string>();
  if (previous.serverName !== next.serverName) propertyUpdates.set('server-name', next.serverName);
  if (previous.levelName !== next.levelName) propertyUpdates.set('level-name', next.levelName);
  if (previous.gamemode !== next.gamemode) propertyUpdates.set('gamemode', next.gamemode);
  if (previous.difficulty !== next.difficulty) propertyUpdates.set('difficulty', next.difficulty);
  if (previous.maxPlayers !== next.maxPlayers) propertyUpdates.set('max-players', String(next.maxPlayers));
  if (previous.seed !== next.seed) propertyUpdates.set('level-seed', next.seed);
  if (previous.viewDistance !== next.viewDistance) propertyUpdates.set('view-distance', String(next.viewDistance));
  if (previous.allowCheats !== next.allowCheats) propertyUpdates.set('allow-cheats', String(next.allowCheats));

  const propertiesPath = path.join(serverDirectory, 'server.properties');
  let propertiesToWrite: string | null = null;
  if (propertyUpdates.size > 0) {
    const propertiesInfo = await lstat(propertiesPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!propertiesInfo?.isFile() || propertiesInfo.isSymbolicLink()) {
      throw new Error('Le fichier server.properties est absent ou non sécurisé ; réglages non enregistrés.');
    }
    const currentProperties = await readFile(propertiesPath, 'utf8');
    propertiesToWrite = applyPropertyUpdates(currentProperties, propertyUpdates);
    if (propertiesToWrite === currentProperties) propertiesToWrite = null;
  }

  const previousAdmins = previous.adminXuids ?? [];
  const adminListChanged = previousAdmins.length !== next.adminXuids.length
    || previousAdmins.some((xuid, index) => xuid !== next.adminXuids[index]);
  const permissionsPath = path.join(serverDirectory, 'permissions.json');
  let permissionsToWrite: string | null = null;
  if (adminListChanged) {
    const permissionsInfo = await lstat(permissionsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (permissionsInfo && (!permissionsInfo.isFile() || permissionsInfo.isSymbolicLink())) {
      throw new Error('Le fichier permissions.json n’est pas sûr ; réglages non enregistrés.');
    }

    let entries: unknown[] = [];
    if (permissionsInfo) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(permissionsPath, 'utf8')) as unknown;
      } catch {
        throw new Error('permissions.json est illisible ; aucun réglage n’a été enregistré.');
      }
      if (!Array.isArray(parsed)) throw new Error('permissions.json n’est pas une liste valide ; aucun réglage n’a été enregistré.');
      entries = parsed;
    }

    const previousSet = new Set(previousAdmins);
    const nextSet = new Set(next.adminXuids);
    const preservedEntries = entries.filter((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return true;
      const xuid = (entry as { xuid?: unknown }).xuid;
      return typeof xuid !== 'string' || (!previousSet.has(xuid) && !nextSet.has(xuid));
    });
    const existingByXuid = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.xuid === 'string') existingByXuid.set(record.xuid, record);
    }
    const updatedAdmins = next.adminXuids.map((xuid) => ({
      ...(existingByXuid.get(xuid) ?? {}),
      permission: 'operator',
      xuid,
    }));
    permissionsToWrite = `${JSON.stringify([...preservedEntries, ...updatedAdmins], null, 2)}\n`;
  }

  if (propertiesToWrite !== null) await writeConfigurationFile(propertiesPath, propertiesToWrite, false);
  if (permissionsToWrite !== null) await writeConfigurationFile(permissionsPath, permissionsToWrite, false);
}

function applyPropertyUpdates(content: string, updates: ReadonlyMap<string, string>): string {
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (content.endsWith('\n')) lines.pop();
  const written = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const separator = line.indexOf('=');
    const key = separator < 0 ? '' : line.slice(0, separator).trim();
    const replacement = updates.get(key);
    if (replacement === undefined) {
      result.push(line);
      continue;
    }
    if (written.has(key)) continue;
    result.push(`${key}=${replacement}`);
    written.add(key);
  }

  for (const [key, value] of updates) {
    if (written.has(key)) continue;
    result.push(`${key}=${value}`);
  }
  return `${result.join('\n')}\n`;
}

async function writeConfigurationFile(filePath: string, content: string, onlyIfMissing: boolean): Promise<void> {
  const current = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current?.isSymbolicLink() || (current && !current.isFile())) {
    throw new Error(`Le fichier de configuration ${path.basename(filePath)} n’est pas un fichier sûr.`);
  }
  if (onlyIfMissing && current) return;

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
