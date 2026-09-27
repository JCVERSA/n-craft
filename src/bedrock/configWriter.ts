import { mkdir, rm, writeFile } from 'node:fs/promises';
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
 * Generates the two supported configuration files from scratch. Network ports,
 * online-mode and allow-list are deliberately locked and never accepted from input.
 */
export async function writeBedrockConfiguration(
  serverDirectory: string,
  configuration: DeployConfiguration,
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

  await writeFile(path.join(serverDirectory, 'server.properties'), properties, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(serverDirectory, 'permissions.json'), `${JSON.stringify(permissions, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  // Official archives can contain a default allowlist. The product decision is an
  // open server, so remove both historical filenames and do not create either one.
  await Promise.all([
    rm(path.join(serverDirectory, 'allowlist.json'), { force: true }),
    rm(path.join(serverDirectory, 'whitelist.json'), { force: true }),
  ]);
}
