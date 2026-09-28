import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from './privateStorage.ts';

const DEFAULT_DAILY_LIMIT = 100;
const MAX_DAILY_LIMIT = 100_000;
const MAX_CONTEXT_EXCHANGES = 10;
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_INPUT_CHARACTERS = 400;
const MAX_REPLY_CHARACTERS = 280;
const SYSTEM_INSTRUCTION = [
  'Tu es un chatbot conversationnel dans le chat public d’un serveur Minecraft Bedrock.',
  'Réponds de façon concise, bienveillante et dans la langue du joueur; privilégie le français.',
  'Tu ne peux pas voir le monde, les joueurs, les fichiers ou l’état du serveur.',
  'Tu ne peux exécuter aucune commande, utiliser aucun outil ni effectuer aucune action dans Minecraft.',
  'Ne prétends jamais avoir exécuté une action ou vérifié une information propre à ce serveur.',
  'Tes réponses sont publiques dans le chat Minecraft; ne demande pas de mot de passe, code ou donnée personnelle.',
].join(' ');

export interface ChatbotAIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatbotAIProvider = (messages: readonly ChatbotAIMessage[], systemInstruction: string) => Promise<string>;
export type ChatbotAIProviderName = 'gemini' | 'nvidia';

export interface ChatbotAIOptions {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  providers?: Partial<Record<ChatbotAIProviderName, ChatbotAIProvider | null>>;
}

export type ChatbotAIAnswer =
  | { status: 'answered'; message: string }
  | { status: 'busy' }
  | { status: 'daily_limit' }
  | { status: 'unavailable' };

interface StoredQuota {
  schemaVersion: 1;
  utcDay: string;
  used: number;
}

function readDailyLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_DAILY_LIMIT;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_DAILY_LIMIT
    ? parsed
    : DEFAULT_DAILY_LIMIT;
}

function readModel(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() ?? '';
  return candidate && /^[A-Za-z0-9._/-]{1,120}$/.test(candidate) ? candidate : fallback;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function cleanReply(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const characters = Array.from(normalized);
  return characters.length <= MAX_REPLY_CHARACTERS
    ? normalized
    : `${characters.slice(0, MAX_REPLY_CHARACTERS - 1).join('').trimEnd()}…`;
}

function toGeminiRole(role: ChatbotAIMessage['role']): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user';
}

function createGeminiProvider(apiKey: string, model: string): ChatbotAIProvider {
  const client = new GoogleGenAI({ apiKey });
  return async (messages, systemInstruction) => {
    const response = await client.models.generateContent({
      model,
      contents: messages.map((message) => ({
        role: toGeminiRole(message.role),
        parts: [{ text: message.content }],
      })),
      config: {
        systemInstruction,
        temperature: 0.65,
        maxOutputTokens: 256,
        httpOptions: { timeout: 25_000, retryOptions: { attempts: 1 } },
      },
    });
    return response.text ?? '';
  };
}

function createNvidiaProvider(apiKey: string, model: string): ChatbotAIProvider {
  return async (messages, systemInstruction) => {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          ...messages.map(({ role, content }) => ({ role, content })),
        ],
        temperature: 0.65,
        max_tokens: 192,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error('NVIDIA provider request failed.');
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  };
}

function isQuota(value: unknown): value is StoredQuota {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.utcDay === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(record.utcDay)
    && Number.isSafeInteger(record.used)
    && (record.used as number) >= 0;
}

/** Conversation context is intentionally memory-only; only an aggregate UTC quota is persisted. */
export class ChatbotAIService {
  readonly quotaFilePath: string;
  readonly dailyLimit: number;
  readonly geminiConfigured: boolean;
  readonly nvidiaConfigured: boolean;

  private readonly now: () => number;
  private readonly geminiProvider: ChatbotAIProvider | null;
  private readonly nvidiaProvider: ChatbotAIProvider | null;
  private readonly history: ChatbotAIMessage[] = [];
  private quota: StoredQuota | null = null;
  private initialized = false;
  private requestInFlight = false;
  private lastRequestAt: number | null = null;
  private expirationTimer: NodeJS.Timeout | null = null;
  private quotaWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storageDirectory: string, options: ChatbotAIOptions = {}) {
    const environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.dailyLimit = readDailyLimit(environment.CHATBOT_DAILY_LIMIT);
    this.quotaFilePath = path.join(storageDirectory, 'quota.json');

    const geminiKey = environment.GEMINI_API_KEY?.trim() ?? '';
    const nvidiaKey = environment.NVIDIA_NIM_API_KEY?.trim() ?? '';
    const geminiModel = readModel(environment.CHATBOT_GEMINI_MODEL, 'gemini-3.8-flash');
    const nvidiaModel = readModel(environment.CHATBOT_NIM_MODEL, 'meta/llama-3.3-70b-instruct');
    this.geminiProvider = options.providers && Object.hasOwn(options.providers, 'gemini')
      ? options.providers.gemini ?? null
      : geminiKey ? createGeminiProvider(geminiKey, geminiModel) : null;
    this.nvidiaProvider = options.providers && Object.hasOwn(options.providers, 'nvidia')
      ? options.providers.nvidia ?? null
      : nvidiaKey ? createNvidiaProvider(nvidiaKey, nvidiaModel) : null;
    this.geminiConfigured = Boolean(this.geminiProvider);
    this.nvidiaConfigured = Boolean(this.nvidiaProvider);
  }

  get hasProvider(): boolean {
    return this.geminiConfigured || this.nvidiaConfigured;
  }

  get dailyUsed(): number {
    if (!this.quota || this.quota.utcDay !== utcDay(this.now())) return 0;
    return this.quota.used;
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.storageDirectory);
    const stored = await readPrivateJson(this.quotaFilePath);
    const currentDay = utcDay(this.now());
    if (stored === null) {
      this.quota = { schemaVersion: 1, utcDay: currentDay, used: 0 };
      await this.persistQuota();
    } else {
      if (!isQuota(stored)) throw new Error('Le compteur de quota du chatbot est invalide.');
      this.quota = stored.utcDay === currentDay
        ? { schemaVersion: 1, utcDay: stored.utcDay, used: stored.used }
        : { schemaVersion: 1, utcDay: currentDay, used: 0 };
      if (stored.utcDay !== currentDay) await this.persistQuota();
    }
    this.initialized = true;
  }

  async answer(rawQuestion: string): Promise<ChatbotAIAnswer> {
    const timestamp = this.now();
    this.expireIfNeeded(timestamp);
    this.lastRequestAt = timestamp;
    this.scheduleExpiration(timestamp);

    if (!this.initialized || !this.hasProvider) return { status: 'unavailable' };
    if (this.requestInFlight) return { status: 'busy' };
    this.requestInFlight = true;

    try {
      const day = utcDay(timestamp);
      if (!this.quota) return { status: 'unavailable' };
      if (this.quota.utcDay !== day) {
        this.quota = { schemaVersion: 1, utcDay: day, used: 0 };
        try {
          await this.persistQuota();
        } catch {
          return { status: 'unavailable' };
        }
      }
      if (this.dailyLimit === 0 || this.quota.used >= this.dailyLimit) return { status: 'daily_limit' };

      const previousQuota = this.quota;
      this.quota = { ...this.quota, used: this.quota.used + 1 };
      try {
        // Reserve the request before contacting a provider so a restart cannot bypass the cap.
        await this.persistQuota();
      } catch {
        this.quota = previousQuota;
        return { status: 'unavailable' };
      }

      const question = Array.from(rawQuestion.trim()).slice(0, MAX_INPUT_CHARACTERS).join('');
      if (!question) return { status: 'unavailable' };
      const context = [
        ...this.history.slice(-MAX_CONTEXT_EXCHANGES * 2),
        { role: 'user' as const, content: question },
      ];
      let responseText = '';
      if (this.geminiProvider) {
        try {
          responseText = await this.geminiProvider(context, SYSTEM_INSTRUCTION);
        } catch {
          // Gemini is primary; a configured NVIDIA NIM endpoint is the only fallback.
        }
      }
      if (!cleanReply(responseText) && this.nvidiaProvider) {
        try {
          responseText = await this.nvidiaProvider(context, SYSTEM_INSTRUCTION);
        } catch {
          // Provider error details and request content are never logged or returned to clients.
        }
      }

      const answer = cleanReply(responseText);
      if (!answer) return { status: 'unavailable' };
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      if (this.history.length > MAX_CONTEXT_EXCHANGES * 2) {
        this.history.splice(0, this.history.length - MAX_CONTEXT_EXCHANGES * 2);
      }
      return { status: 'answered', message: answer };
    } finally {
      this.requestInFlight = false;
    }
  }

  clearMemory(): void {
    this.history.length = 0;
    this.lastRequestAt = null;
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
  }

  shutdown(): void {
    this.clearMemory();
  }

  private expireIfNeeded(now: number): void {
    if (this.lastRequestAt === null) return;
    if (now < this.lastRequestAt || now - this.lastRequestAt >= CONTEXT_TTL_MS) {
      this.history.length = 0;
      this.lastRequestAt = null;
    }
  }

  private scheduleExpiration(requestAt: number): void {
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    this.expirationTimer = setTimeout(() => {
      this.expirationTimer = null;
      if (this.lastRequestAt !== requestAt) return;
      this.expireIfNeeded(this.now());
    }, CONTEXT_TTL_MS + 10);
    this.expirationTimer.unref?.();
  }

  private persistQuota(): Promise<void> {
    const quota = this.quota;
    if (!quota) return Promise.reject(new Error('Quota not initialized.'));
    const write = this.quotaWriteQueue.then(() => writePrivateJson(this.quotaFilePath, quota));
    this.quotaWriteQueue = write.catch(() => undefined);
    return write;
  }
}
