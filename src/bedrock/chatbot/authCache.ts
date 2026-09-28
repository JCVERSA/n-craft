import path from 'node:path';
import {
  ensurePrivateDirectory,
  readPrivateJson,
  removePrivateFile,
  writePrivateJson,
} from './privateStorage.ts';

const AUTH_CACHE_NAMES = new Set(['live', 'sisu', 'msal', 'xbl', 'bed', 'mca', 'mcs', 'pfb']);
export const CHATBOT_AUTHFLOW_USERNAME = 'ncraft-bedrock-chatbot';

interface CacheFactoryArguments {
  cacheName: string;
  username: string;
}

interface PrismarineCache {
  reset(): Promise<Record<string, unknown>>;
  getCached(): Promise<Record<string, unknown>>;
  setCached(value: Record<string, unknown>): Promise<void>;
  setCachedPartial(value: Record<string, unknown>): Promise<void>;
}

class PrivatePrismarineCache implements PrismarineCache {
  private value: Record<string, unknown> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly isWritable: () => boolean,
  ) {}

  async reset(): Promise<Record<string, unknown>> {
    await this.setCached({});
    return {};
  }

  async getCached(): Promise<Record<string, unknown>> {
    if (this.value === null) {
      const cached = await readPrivateJson(this.filePath);
      if (cached === null) this.value = {};
      else if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
        this.value = cached as Record<string, unknown>;
      } else {
        throw new Error('Le cache privé Microsoft du chatbot est invalide.');
      }
    }
    return structuredClone(this.value);
  }

  async setCached(value: Record<string, unknown>): Promise<void> {
    if (!this.isWritable()) throw new Error('Écriture du cache Microsoft annulée.');
    const next = structuredClone(value);
    const write = this.writeQueue.then(async () => {
      if (!this.isWritable()) throw new Error('Écriture du cache Microsoft annulée.');
      await writePrivateJson(this.filePath, next);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    this.value = next;
  }

  async setCachedPartial(value: Record<string, unknown>): Promise<void> {
    await this.setCached({ ...(await this.getCached()), ...value });
  }

  async flushAndForget(): Promise<void> {
    await this.writeQueue;
    this.value = {};
  }
}

interface LinkMarker {
  schemaVersion: 1;
  linked: true;
  linkedAt: string;
}

/** Private, atomic OAuth cache used instead of prismarine-auth's default FileCache. */
export class ChatbotAuthCacheStore {
  readonly directory: string;
  readonly linkedMarkerPath: string;
  private writesAllowed = false;
  private readonly caches = new Map<string, PrivatePrismarineCache>();

  constructor(private readonly chatbotDataDirectory: string) {
    this.directory = path.join(chatbotDataDirectory, 'auth');
    this.linkedMarkerPath = path.join(this.directory, 'linked.json');
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.chatbotDataDirectory);
    await ensurePrivateDirectory(this.directory);
    await this.isLinked();
  }

  setWritesAllowed(allowed: boolean): void {
    this.writesAllowed = allowed;
  }

  readonly factory = ({ cacheName, username }: CacheFactoryArguments): PrismarineCache => {
    if (username !== CHATBOT_AUTHFLOW_USERNAME || !AUTH_CACHE_NAMES.has(cacheName)) {
      throw new Error('Demande de cache Microsoft non autorisée.');
    }
    let cache = this.caches.get(cacheName);
    if (!cache) {
      cache = new PrivatePrismarineCache(
        path.join(this.directory, `${cacheName}-cache.json`),
        () => this.writesAllowed,
      );
      this.caches.set(cacheName, cache);
    }
    return cache;
  };

  async isLinked(): Promise<boolean> {
    const value = await readPrivateJson(this.linkedMarkerPath);
    if (value === null) return false;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Le marqueur de liaison Microsoft est invalide.');
    }
    const record = value as Record<string, unknown>;
    return record.schemaVersion === 1 && record.linked === true && typeof record.linkedAt === 'string';
  }

  async markLinked(now = Date.now()): Promise<void> {
    const marker: LinkMarker = {
      schemaVersion: 1,
      linked: true,
      linkedAt: new Date(now).toISOString(),
    };
    await writePrivateJson(this.linkedMarkerPath, marker);
  }

  async clearUnlinkedCaches(): Promise<void> {
    if (await this.isLinked()) return;
    this.writesAllowed = false;
    await this.flushCaches();
    await this.removeCredentialFiles();
  }

  async unlinkAndClear(): Promise<void> {
    this.writesAllowed = false;
    await this.flushCaches();
    await this.removeCredentialFiles();
    await removePrivateFile(this.linkedMarkerPath);
  }

  private async flushCaches(): Promise<void> {
    await Promise.all([...this.caches.values()].map((cache) => cache.flushAndForget()));
    this.caches.clear();
  }

  private async removeCredentialFiles(): Promise<void> {
    for (const cacheName of AUTH_CACHE_NAMES) {
      await removePrivateFile(path.join(this.directory, `${cacheName}-cache.json`));
    }
  }
}
