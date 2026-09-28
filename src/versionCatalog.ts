import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { VersionEntry } from './types/backend.ts';

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'minecraft.net',
  'www.minecraft.net',
  'minecraft.azureedge.net',
]);

const MAX_CLIENT_VERSION = [1, 21, 132];

export function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function parseEntries(value: unknown): VersionEntry[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { versions?: unknown }).versions)) {
    throw new Error('versions.json doit contenir un tableau "versions".');
  }

  const entries = (value as { versions: unknown[] }).versions.map((item, index): VersionEntry => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Entrée de version #${index + 1} invalide.`);
    }
    const raw = item as Record<string, unknown>;
    const version = typeof raw.version === 'string' ? raw.version.trim() : '';
    const clientVersion = typeof raw.clientVersion === 'string' ? raw.clientVersion.trim() : '';
    const channel = raw.channel === 'preview' ? 'preview' : raw.channel === 'stable' ? 'stable' : null;
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const downloadUrl = typeof raw.downloadUrl === 'string' ? raw.downloadUrl.trim() : '';
    const releaseDate = raw.releaseDate === null ? null : typeof raw.releaseDate === 'string' ? raw.releaseDate.trim() : null;

    if (!/^\d+(?:\.\d+){1,4}$/.test(version)) {
      throw new Error(`Identifiant de version invalide dans l’entrée #${index + 1}.`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(clientVersion)) {
      throw new Error(`Version Bedrock cliente invalide pour BDS ${version}.`);
    }
    if (compareNumericVersions(clientVersion, MAX_CLIENT_VERSION.join('.')) >= 0) {
      throw new Error(`La version Bedrock ${clientVersion} dépasse la limite du catalogue (avant 1.21.132).`);
    }
    if (!channel) throw new Error(`Canal invalide pour BDS ${version}.`);
    if (!label || label.length > 160) throw new Error(`Label invalide pour Bedrock ${version}.`);
    if (releaseDate !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) || Number.isNaN(Date.parse(`${releaseDate}T00:00:00Z`)))) {
      throw new Error(`Date de sortie invalide pour Bedrock ${version}.`);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(downloadUrl);
    } catch {
      throw new Error(`URL de téléchargement invalide pour Bedrock ${version}.`);
    }
    if (
      parsedUrl.protocol !== 'https:' ||
      !ALLOWED_DOWNLOAD_HOSTS.has(parsedUrl.hostname.toLowerCase()) ||
      !/^\/bedrockdedicatedserver\/bin-linux\/bedrock-server-[\d.]+\.zip$/.test(parsedUrl.pathname)
    ) {
      throw new Error(`L’URL de Bedrock ${version} doit être un ZIP Linux hébergé sur le domaine officiel Minecraft.`);
    }

    return { version, clientVersion, channel, label, downloadUrl, releaseDate };
  });

  if (new Set(entries.map((entry) => entry.version)).size !== entries.length) {
    throw new Error('versions.json contient des identifiants de version en double.');
  }
  return entries;
}

export class VersionCatalog {
  readonly filePath: string;
  private entries: VersionEntry[] = [];

  constructor(
    dataDirectory: string,
    private readonly seedFilePath = path.resolve(process.cwd(), 'data', 'versions.json'),
  ) {
    this.filePath = path.join(dataDirectory, 'versions.json');
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const source = await readFile(this.filePath, 'utf8');
      this.entries = parseEntries(JSON.parse(source) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (path.resolve(this.seedFilePath) !== path.resolve(this.filePath)) {
        try {
          const seed = await readFile(this.seedFilePath, 'utf8');
          this.entries = parseEntries(JSON.parse(seed) as unknown);
          await writeFile(this.filePath, seed, 'utf8',);
          return;
        } catch (seedError) {
          if ((seedError as NodeJS.ErrnoException).code !== 'ENOENT') throw seedError;
        }
      }
      this.entries = [];
      await writeFile(this.filePath, '{\n  "versions": []\n}\n', 'utf8');
    }
  }

  all(): VersionEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  publicEntries(): Array<Omit<VersionEntry, 'downloadUrl'>> {
    return this.entries.map(({ downloadUrl: _downloadUrl, ...entry }) => ({ ...entry }));
  }

  get(version: string): VersionEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.version === version);
    return entry ? { ...entry } : undefined;
  }

  allowedVersionIds(): ReadonlySet<string> {
    return new Set(this.entries.map((entry) => entry.version));
  }
}

export const versionDownloadHosts = ALLOWED_DOWNLOAD_HOSTS;
