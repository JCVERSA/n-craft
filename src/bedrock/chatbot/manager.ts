import { createRequire } from 'node:module';
import path from 'node:path';
import type { VersionEntry, PersistentPanelState, ChatbotSnapshot } from '../../types/backend.ts';
import type { BedrockConsole } from '../console.ts';
import type { StateStore } from '../../state.ts';
import { ChatbotAIService, type ChatbotAIAnswer } from './aiService.ts';
import { ChatbotAuthCacheStore, CHATBOT_AUTHFLOW_USERNAME } from './authCache.ts';
import { assessChatbotProtocol } from './protocolSupport.ts';
import { checkBedrockOperatorXuid } from './permissions.ts';
import { ensurePrivateDirectory } from './privateStorage.ts';

const DEVICE_CODE_MAX_MS = 20 * 60 * 1000;
const DEVICE_CODE_FALLBACK_MS = 10 * 60 * 1000;
const CHATBOT_CLIENT_TIMEOUT_MS = 12_000;
const BUSY_NOTICE_INTERVAL_MS = 8_000;
const MAX_CHATBOT_INPUT_CHARACTERS = 400;
const BOT_CLIENT_NAME = 'N-Craft assistant';

interface DeviceCodeData {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

interface AuthTokenManager {
  verifyTokens(): Promise<boolean>;
  getAccessToken(): Promise<{ token?: string } | undefined>;
  authDeviceCode(callback: (response: DeviceCodeData) => void): Promise<{ accessToken?: string }>;
  polling?: boolean;
}

interface AuthFlowLike {
  msa?: AuthTokenManager;
}

interface ProfileLike {
  name?: string;
  xuid?: string | number;
}

interface ProtocolTextPacket {
  type?: string;
  message?: string;
  source_name?: string;
  xuid?: string;
}

interface BedrockProtocolClient {
  options: { protocolVersion?: number; version?: string };
  username?: string;
  profile?: ProfileLike;
  status?: number;
  on(event: string, listener: (...args: unknown[]) => void): this;
  init(): void;
  connect(): void;
  queue(name: string, parameters: Record<string, unknown>): void;
  disconnect(reason?: string, hide?: boolean): void;
  close(reason?: string): void;
}

interface BedrockProtocolClientConstructor {
  new(options: Record<string, unknown>): BedrockProtocolClient;
}

interface PrismarineAuthConstructor {
  new(
    username: string,
    cache: (options: { cacheName: string; username: string }) => unknown,
    options: Record<string, unknown>,
    codeCallback: (response: DeviceCodeData) => void,
  ): AuthFlowLike & {
    codeCallback?: (response: DeviceCodeData) => void;
    getMsaToken(): Promise<string>;
  };
}

interface PrismarineAuthModule {
  Authflow: PrismarineAuthConstructor;
  Titles: { MinecraftNintendoSwitch: string };
}

interface ChatbotManagerOptions {
  dataDirectory: string;
  serverDirectory: string;
  bedrockConsole: BedrockConsole;
  state: StateStore;
  findVersion: (version: string) => VersionEntry | undefined;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  clientFactory?: (options: Record<string, unknown>) => BedrockProtocolClient;
  authFlowFactory?: (
    username: string,
    cache: (options: { cacheName: string; username: string }) => unknown,
    options: Record<string, unknown>,
    callback: (response: DeviceCodeData) => void,
  ) => AuthFlowLike;
}

class ReauthenticationRequiredError extends Error {
  constructor() {
    super('Microsoft device approval requires an explicit user action.');
    this.name = 'ChatbotReauthenticationRequired';
  }
}

const require = createRequire(import.meta.url);
const debug = require('debug') as { load(): string | undefined; enable(namespaces: string): void };
const requestedDebugNamespaces = debug.load();
debug.enable([requestedDebugNamespaces?.trim(), '-prismarine-auth*', '-minecraft-protocol*'].filter(Boolean).join(','));
if (requestedDebugNamespaces === undefined) delete process.env.DEBUG;
else process.env.DEBUG = requestedDebugNamespaces;
const { Client: ProtocolClient } = require('bedrock-protocol/src/client.js') as { Client: BedrockProtocolClientConstructor };
const prismarineAuth = require('prismarine-auth') as PrismarineAuthModule;

/** Avoid prismarine-auth's console message that prints the signed-in account name. */
class QuietAuthflow extends prismarineAuth.Authflow {
  async getMsaToken(): Promise<string> {
    const msa = this.msa;
    if (!msa) throw new Error('Microsoft token manager unavailable.');
    if (await msa.verifyTokens()) {
      const cached = await msa.getAccessToken();
      if (cached?.token) return cached.token;
    }
    const response = await msa.authDeviceCode((data) => this.codeCallback?.(data));
    if (!response.accessToken) throw new Error('Microsoft did not return an access token.');
    return response.accessToken;
  }
}

export function parseChatbotTrigger(message: unknown): string | null {
  if (typeof message !== 'string' || !message.startsWith('.. ') || /[\r\n\0]/.test(message)) return null;
  const question = message.slice(3).trim();
  return question ? question : null;
}

function isReauthenticationRequired(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'ChatbotReauthenticationRequired');
}

function safeVerificationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === 'microsoft.com'
      || host === 'www.microsoft.com'
      || host === 'account.microsoft.com'
      || host === 'login.microsoftonline.com';
    return url.protocol === 'https:' && allowedHost ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeDeviceCode(value: string): string | null {
  const code = value.trim();
  return /^[A-Za-z0-9-]{4,32}$/.test(code) ? code : null;
}

/** Owns one authenticated Bedrock client, with no console, command, or world-control tools. */
export class BedrockChatbotManager {
  private readonly chatbotDataDirectory: string;
  private readonly authCache: ChatbotAuthCacheStore;
  private readonly ai: ChatbotAIService;
  private readonly now: () => number;
  private readonly clientFactory: (options: Record<string, unknown>) => BedrockProtocolClient;
  private readonly authFlowFactory: NonNullable<ChatbotManagerOptions['authFlowFactory']>;
  private initialized = false;
  private shuttingDown = false;
  private linked = false;
  private status: ChatbotSnapshot['status'] = 'server_stopped';
  private message = 'Le chatbot attend un serveur Bedrock compatible.';
  private latestState: PersistentPanelState;
  private currentClient: BedrockProtocolClient | null = null;
  private currentAuthFlow: AuthFlowLike | null = null;
  private connectionGeneration = 0;
  private connectionMode: 'user' | 'automatic' = 'automatic';
  private userInitiatedFlow = false;
  private mayStartDeviceFlow = false;
  private deviceCode: ChatbotSnapshot['deviceCode'] = null;
  private deviceCodeTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private lastBusyNoticeAt = 0;
  private quotaNoticeDay = '';
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ChatbotManagerOptions) {
    this.chatbotDataDirectory = path.join(options.dataDirectory, 'bedrock-chatbot');
    this.authCache = new ChatbotAuthCacheStore(this.chatbotDataDirectory);
    this.now = options.now ?? Date.now;
    this.latestState = options.state.getSnapshot();
    this.ai = new ChatbotAIService(this.chatbotDataDirectory, {
      environment: options.environment ?? process.env,
      now: this.now,
    });
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new ProtocolClient(clientOptions));
    this.authFlowFactory = options.authFlowFactory ?? ((username, cache, authOptions, callback) => (
      new QuietAuthflow(username, cache, authOptions, callback)
    ));
  }

  async initialize(): Promise<void> {
    try {
      await ensurePrivateDirectory(this.chatbotDataDirectory);
      await this.authCache.initialize();
      await this.ai.initialize();
      this.linked = await this.authCache.isLinked();
      if (!this.linked) await this.authCache.clearUnlinkedCaches();
      this.initialized = true;
      this.status = this.linked ? 'linked' : 'server_stopped';
      this.message = this.linked
        ? 'Le compte dédié est lié; le chatbot se connectera uniquement à un build validé.'
        : 'Le compte dédié n’est pas lié. Le flux Microsoft reste arrêté jusqu’à une demande explicite.';
    } catch {
      this.status = 'failed';
      this.message = 'Stockage privé du chatbot indisponible; aucune connexion Bedrock ni requête IA ne sera lancée.';
      this.initialized = false;
    }
  }

  getSnapshot(): ChatbotSnapshot {
    const build = this.latestState.activeConfig?.version;
    const entry = build ? this.options.findVersion(build) : undefined;
    const protocol = assessChatbotProtocol(entry ?? null);
    const serverOnline = this.isServerOnline(this.latestState);
    const providersConfigured = this.ai.hasProvider;
    const operationActive = Boolean(this.currentClient || this.userInitiatedFlow);
    const canLink = this.initialized
      && !this.shuttingDown
      && serverOnline
      && protocol.supported
      && providersConfigured
      && !operationActive
      && this.status !== 'online';

    return {
      status: this.status,
      message: this.message,
      serverOnline,
      build: protocol.build,
      clientVersion: protocol.clientVersion,
      protocolVersion: protocol.protocolVersion,
      protocolSupported: protocol.supported,
      protocolTested: protocol.tested,
      protocolNote: protocol.reason,
      accountLinked: this.linked,
      userActionPending: this.userInitiatedFlow,
      canLink,
      geminiConfigured: this.ai.geminiConfigured,
      nvidiaConfigured: this.ai.nvidiaConfigured,
      dailyLimit: this.ai.dailyLimit,
      dailyUsed: this.ai.dailyUsed,
      deviceCode: this.deviceCode ? { ...this.deviceCode } : null,
      occupiesPlayerSlot: this.status === 'online',
    };
  }

  /** Called from state changes; cached profiles reconnect without starting a new device-code flow. */
  syncState(snapshot: PersistentPanelState): Promise<void> {
    this.latestState = snapshot;
    const sync = this.syncQueue.then(() => this.applyServerState(snapshot));
    this.syncQueue = sync.catch(() => undefined);
    return sync;
  }

  async onBedrockExit(): Promise<void> {
    this.ai.clearMemory();
    await this.syncState(this.options.state.getSnapshot());
  }

  /** A direct dashboard action is the distinct approval required to start Microsoft device auth. */
  async startUserApprovedLink(): Promise<void> {
    if (!this.initialized || this.shuttingDown) throw new Error('Stockage privé du chatbot indisponible.');
    if (this.currentClient || this.userInitiatedFlow) throw new Error('Une connexion du chatbot est déjà en cours.');

    const snapshot = this.options.state.getSnapshot();
    this.latestState = snapshot;
    const eligibility = this.eligibility(snapshot);
    if (!eligibility.allowed) throw new Error(eligibility.message);
    if (this.status === 'online') throw new Error('Le chatbot est déjà connecté au serveur Bedrock.');

    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.connectionMode = 'user';
    this.userInitiatedFlow = true;
    this.mayStartDeviceFlow = true;
    this.message = 'Connexion au serveur; aucun code ne sera affiché avant le flux Microsoft officiel.';
    this.status = 'connecting';
    this.authCache.setWritesAllowed(true);
    try {
      this.startClient(true);
    } catch {
      this.userInitiatedFlow = false;
      this.mayStartDeviceFlow = false;
      this.authCache.setWritesAllowed(false);
      this.status = 'failed';
      this.message = 'Impossible de créer le client Bedrock. Aucun code Microsoft n’a été demandé.';
      throw new Error(this.message);
    }
  }

  async cancelUserApprovedLink(): Promise<void> {
    if (!this.userInitiatedFlow) return;
    this.userInitiatedFlow = false;
    this.mayStartDeviceFlow = false;
    this.clearDeviceCodeTimer();
    this.deviceCode = null;
    this.authCache.setWritesAllowed(false);
    const flow = this.currentAuthFlow as (AuthFlowLike & { msa?: AuthTokenManager }) | null;
    if (flow?.msa) flow.msa.polling = false;
    this.closeCurrentClient('Liaison annulée par l’opérateur.');
    if (!this.linked) await this.authCache.clearUnlinkedCaches().catch(() => undefined);
    this.status = this.linked ? 'linked' : 'not_linked';
    this.message = this.linked
      ? 'Tentative d’autorisation annulée; le profil déjà lié est conservé.'
      : 'Liaison annulée. Aucun nouveau flux Microsoft ne démarrera sans une nouvelle confirmation.';
  }

  async unlinkAccount(): Promise<void> {
    this.clearReconnectTimer();
    this.userInitiatedFlow = false;
    this.mayStartDeviceFlow = false;
    this.deviceCode = null;
    this.clearDeviceCodeTimer();
    this.closeCurrentClient('Profil du chatbot délié.');
    await this.authCache.unlinkAndClear();
    this.linked = false;
    this.status = this.isServerOnline(this.latestState) ? 'not_linked' : 'server_stopped';
    this.message = 'Profil et jetons Bedrock supprimés du stockage privé.';
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.clearReconnectTimer();
    this.clearDeviceCodeTimer();
    this.deviceCode = null;
    this.userInitiatedFlow = false;
    this.mayStartDeviceFlow = false;
    this.authCache.setWritesAllowed(false);
    this.closeCurrentClient('Panneau N-Craft arrêté.');
    if (!this.linked) await this.authCache.clearUnlinkedCaches().catch(() => undefined);
    this.ai.shutdown();
    this.status = this.linked ? 'linked' : 'server_stopped';
    this.message = 'Le panneau s’arrête; la mémoire de conversation est effacée.';
  }

  private async applyServerState(snapshot: PersistentPanelState): Promise<void> {
    if (!this.initialized || this.shuttingDown) return;
    if (!this.isServerOnline(snapshot)) {
      this.clearReconnectTimer();
      if (this.userInitiatedFlow) await this.cancelUserApprovedLink();
      else this.closeCurrentClient('Serveur Bedrock arrêté.');
      this.status = this.linked ? 'linked' : 'server_stopped';
      this.message = this.linked
        ? 'Compte dédié lié; en attente d’un serveur Bedrock en ligne.'
        : 'Le chatbot reste arrêté tant que Bedrock n’est pas en ligne.';
      return;
    }
    if (this.userInitiatedFlow) return;

    const eligibility = this.eligibility(snapshot);
    if (!eligibility.allowed) {
      this.clearReconnectTimer();
      this.closeCurrentClient('Chatbot indisponible.');
      this.status = eligibility.status;
      this.message = eligibility.message;
      return;
    }
    if (!this.linked) {
      this.clearReconnectTimer();
      this.closeCurrentClient('Compte du chatbot non lié.');
      this.status = 'not_linked';
      this.message = 'Le build est compatible. Lier un compte dédié nécessite une confirmation explicite dans Diagnostics.';
      return;
    }
    if (this.status === 'reauth_required' || this.status === 'account_operator' || this.status === 'failed') return;
    if (this.currentClient || this.reconnectTimer) return;

    this.connectionMode = 'automatic';
    this.mayStartDeviceFlow = false;
    this.authCache.setWritesAllowed(true);
    try {
      this.startClient(false);
    } catch {
      this.status = 'failed';
      this.message = 'Le client Bedrock n’a pas pu démarrer; vérifie le runtime puis relance le panneau.';
      this.scheduleReconnect();
    }
  }

  private eligibility(snapshot: PersistentPanelState): {
    allowed: boolean;
    status: ChatbotSnapshot['status'];
    message: string;
  } {
    if (!this.isServerOnline(snapshot)) {
      return { allowed: false, status: 'server_stopped', message: 'Bedrock doit être en ligne avant de connecter le chatbot.' };
    }
    const version = snapshot.activeConfig?.version;
    const entry = version ? this.options.findVersion(version) : undefined;
    const protocol = assessChatbotProtocol(entry ?? null);
    if (!protocol.supported) {
      return { allowed: false, status: 'unsupported_build', message: protocol.reason };
    }
    if (!this.ai.hasProvider) {
      return { allowed: false, status: 'ai_not_configured', message: 'Configure au moins une clé IA côté serveur dans .env; aucune clé n’est affichée au dashboard.' };
    }
    return { allowed: true, status: 'not_linked', message: 'Prêt à connecter un compte Bedrock dédié.' };
  }

  private isServerOnline(snapshot: PersistentPanelState): boolean {
    return snapshot.server.status === 'running' && this.options.bedrockConsole.isReady;
  }

  private startClient(allowDeviceCode: boolean): void {
    const snapshot = this.options.state.getSnapshot();
    const version = snapshot.activeConfig?.version;
    const entry = version ? this.options.findVersion(version) : undefined;
    const protocol = assessChatbotProtocol(entry ?? null);
    if (!entry || !protocol.supported || !protocol.clientVersion) {
      throw new Error('Unsupported Bedrock version.');
    }

    const generation = ++this.connectionGeneration;
    const authOptions = {
      flow: 'live',
      authTitle: prismarineAuth.Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
    };
    const authFlow = this.authFlowFactory(
      CHATBOT_AUTHFLOW_USERNAME,
      this.authCache.factory,
      authOptions,
      (response) => this.onDeviceCode(response, generation, allowDeviceCode),
    ) as AuthFlowLike & { msa?: AuthTokenManager };
    if (!allowDeviceCode && authFlow.msa) {
      // A cached profile may refresh silently. If it needs a new device code, stop here;
      // a dashboard confirmation is required before any fresh device-code request.
      authFlow.msa.authDeviceCode = async () => {
        throw new ReauthenticationRequiredError();
      };
    }

    const client = this.clientFactory({
      host: '127.0.0.1',
      port: 19_132,
      version: protocol.clientVersion,
      username: BOT_CLIENT_NAME,
      offline: false,
      raknetBackend: 'raknet-node',
      useRaknetWorkers: false,
      skipPing: true,
      connectTimeout: CHATBOT_CLIENT_TIMEOUT_MS,
      profilesFolder: this.authCache.directory,
      authflow: authFlow,
      flow: 'live',
      authTitle: prismarineAuth.Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      conLog: () => undefined,
    });

    this.currentAuthFlow = authFlow;
    this.currentClient = client;
    this.connectionMode = allowDeviceCode ? 'user' : 'automatic';
    this.status = 'connecting';
    this.message = allowDeviceCode
      ? 'Connexion Bedrock en cours; suis uniquement le code officiel affiché ici si Microsoft le demande.'
      : 'Reconnexion au serveur avec le profil privé déjà approuvé.';

    client.on('connect_allowed', () => {
      if (generation !== this.connectionGeneration || this.currentClient !== client) return;
      this.status = 'connecting';
      client.connect();
    });
    client.on('join', () => {
      if (generation !== this.connectionGeneration || this.currentClient !== client) return;
      this.deviceCode = null;
      this.clearDeviceCodeTimer();
      this.status = 'connecting';
      this.message = 'Compte authentifié; vérification du profil et de l’arrivée dans le monde.';
    });
    client.on('spawn', () => {
      void this.handleSpawn(client, generation);
    });
    client.on('text', (packet) => {
      this.handleTextPacket(client, generation, packet);
    });
    client.on('error', (error) => {
      this.handleClientError(client, generation, error);
    });
    client.on('kick', () => {
      this.handleClientError(client, generation, new Error('Bedrock server rejected the client.'));
    });
    client.on('close', () => {
      this.handleClientClose(client, generation);
    });
    client.init();
  }

  private onDeviceCode(data: DeviceCodeData, generation: number, allowDeviceCode: boolean): void {
    if (generation !== this.connectionGeneration) throw new ReauthenticationRequiredError();
    if (!allowDeviceCode || !this.mayStartDeviceFlow || !this.userInitiatedFlow) {
      throw new ReauthenticationRequiredError();
    }
    const verificationUrl = safeVerificationUrl(data.verification_uri);
    const userCode = safeDeviceCode(data.user_code);
    if (!verificationUrl || !userCode) throw new Error('Microsoft returned an unsupported device-code response.');

    const expiresInMs = Number.isFinite(data.expires_in) && data.expires_in > 0
      ? Math.min(data.expires_in * 1000, DEVICE_CODE_MAX_MS)
      : DEVICE_CODE_FALLBACK_MS;
    const expiresAt = this.now() + expiresInMs;
    this.deviceCode = {
      verificationUrl,
      userCode,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    this.status = 'awaiting_approval';
    this.message = 'Le code Microsoft est temporaire. Approuve-le toi-même sur le site officiel; aucun mot de passe n’est demandé à N-Craft.';
    this.clearDeviceCodeTimer();
    this.deviceCodeTimer = setTimeout(() => {
      if (generation !== this.connectionGeneration || this.status !== 'awaiting_approval') return;
      void this.cancelUserApprovedLink();
    }, expiresInMs + 250);
    this.deviceCodeTimer.unref?.();
  }

  private async handleSpawn(client: BedrockProtocolClient, generation: number): Promise<void> {
    if (generation !== this.connectionGeneration || this.currentClient !== client || this.status === 'online') return;
    const profileXuid = client.profile?.xuid;
    const xuid = typeof profileXuid === 'number' ? String(profileXuid) : profileXuid;
    const operatorCheck = await checkBedrockOperatorXuid(this.options.serverDirectory, xuid);
    if (generation !== this.connectionGeneration || this.currentClient !== client) return;
    if (operatorCheck === 'operator') {
      this.linked = false;
      this.authCache.setWritesAllowed(false);
      await this.authCache.unlinkAndClear().catch(() => undefined);
      this.userInitiatedFlow = false;
      this.mayStartDeviceFlow = false;
      this.deviceCode = null;
      this.closeCurrentClient('Le compte du chatbot ne doit pas être opérateur.');
      this.status = 'account_operator';
      this.message = 'Compte refusé : retire son XUID de permissions.json. Le chatbot ne se connectera jamais en opérateur.';
      return;
    }
    if (operatorCheck !== 'not_operator') {
      this.userInitiatedFlow = false;
      this.mayStartDeviceFlow = false;
      this.authCache.setWritesAllowed(false);
      await this.authCache.clearUnlinkedCaches().catch(() => undefined);
      this.closeCurrentClient('Impossible de vérifier le rôle Bedrock du compte.');
      this.status = 'failed';
      this.message = 'Profil refusé : N-Craft n’a pas pu vérifier que le compte n’est pas opérateur.';
      return;
    }

    try {
      await this.authCache.markLinked(this.now());
    } catch {
      this.userInitiatedFlow = false;
      this.mayStartDeviceFlow = false;
      this.closeCurrentClient('Le profil privé n’a pas pu être enregistré.');
      this.status = 'failed';
      this.message = 'Connexion refusée : le profil n’a pas pu être enregistré dans le stockage privé.';
      return;
    }

    this.linked = true;
    this.userInitiatedFlow = false;
    this.mayStartDeviceFlow = false;
    this.deviceCode = null;
    this.clearDeviceCodeTimer();
    this.reconnectAttempt = 0;
    this.status = 'online';
    this.message = 'Le chatbot est en ligne dans le chat Bedrock. Il occupe un emplacement et ne traite que les messages « .. <message> ». ';
  }

  private handleTextPacket(client: BedrockProtocolClient, generation: number, rawPacket: unknown): void {
    if (generation !== this.connectionGeneration || this.currentClient !== client || this.status !== 'online') return;
    if (!rawPacket || typeof rawPacket !== 'object' || Array.isArray(rawPacket)) return;
    const packet = rawPacket as ProtocolTextPacket;
    if (packet.type !== 'chat' || typeof packet.message !== 'string') return;
    const ownName = client.profile?.name ?? client.username;
    const ownXuid = client.profile?.xuid === undefined ? '' : String(client.profile.xuid);
    if ((ownName && packet.source_name === ownName) || (ownXuid && packet.xuid === ownXuid)) return;

    const question = parseChatbotTrigger(packet.message);
    if (!question) return;
    if (Array.from(question).length > MAX_CHATBOT_INPUT_CHARACTERS) {
      this.sendChat(client, 'Ta question dépasse la limite de 400 caractères.');
      return;
    }
    void this.answerInGame(client, generation, question);
  }

  private async answerInGame(client: BedrockProtocolClient, generation: number, question: string): Promise<void> {
    const result: ChatbotAIAnswer = await this.ai.answer(question);
    if (generation !== this.connectionGeneration || this.currentClient !== client || this.status !== 'online') return;
    if (result.status === 'answered') {
      this.sendChat(client, result.message);
      return;
    }
    if (result.status === 'busy') {
      const now = this.now();
      if (now - this.lastBusyNoticeAt >= BUSY_NOTICE_INTERVAL_MS) {
        this.lastBusyNoticeAt = now;
        this.sendChat(client, 'Une réponse est déjà en préparation; réessaie dans un instant.');
      }
      return;
    }
    if (result.status === 'daily_limit') {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (this.quotaNoticeDay !== day) {
        this.quotaNoticeDay = day;
        this.sendChat(client, 'Le plafond quotidien du chatbot est atteint. Réessaie demain.');
      }
      return;
    }
    this.sendChat(client, 'L’IA est momentanément indisponible; réessaie plus tard.');
  }

  private sendChat(client: BedrockProtocolClient, text: string): void {
    const username = client.profile?.name ?? client.username ?? BOT_CLIENT_NAME;
    const rawXuid = client.profile?.xuid;
    const xuid = rawXuid === undefined ? '' : String(rawXuid);
    const cleanText = Array.from(text.replace(/[\r\n\0]/g, ' ').trim()).slice(0, 300).join('');
    if (!cleanText) return;
    try {
      client.queue('text', {
        needs_translation: false,
        category: 'authored',
        chat: cleanText,
        whisper: '',
        announcement: '',
        type: 'chat',
        source_name: username,
        message: cleanText,
        xuid,
        platform_chat_id: '',
        has_filtered_message: false,
        filtered_message: '',
      });
    } catch {
      // A disappearing client must not affect Bedrock or expose provider errors.
    }
  }

  private handleClientError(client: BedrockProtocolClient, generation: number, error: unknown): void {
    if (generation !== this.connectionGeneration || this.currentClient !== client) return;
    const reauthenticationRequired = isReauthenticationRequired(error);
    const wasAutomatic = this.connectionMode === 'automatic';
    this.releaseClient(client, generation);
    this.userInitiatedFlow = false;
    this.mayStartDeviceFlow = false;
    this.deviceCode = null;
    this.clearDeviceCodeTimer();
    if (!this.linked) {
      this.authCache.setWritesAllowed(false);
      void this.authCache.clearUnlinkedCaches().catch(() => undefined);
    }
    if (reauthenticationRequired && this.linked) {
      this.status = 'reauth_required';
      this.message = 'Le profil a besoin d’une nouvelle approbation Microsoft. Le flux reste arrêté jusqu’à ton prochain clic.';
      return;
    }
    this.status = this.linked ? 'reconnecting' : 'failed';
    this.message = this.linked
      ? 'Connexion Bedrock interrompue; N-Craft réessaiera sans demander de nouveau code Microsoft.'
      : 'Connexion Bedrock échouée. Vérifie le serveur, son allowlist et le réseau; aucun détail d’authentification n’est affiché.';
    if (this.linked && wasAutomatic) this.scheduleReconnect();
  }

  private handleClientClose(client: BedrockProtocolClient, generation: number): void {
    if (generation !== this.connectionGeneration || this.currentClient !== client) return;
    const wasAutomatic = this.connectionMode === 'automatic';
    this.currentClient = null;
    this.currentAuthFlow = null;
    this.userInitiatedFlow = false;
    this.mayStartDeviceFlow = false;
    this.deviceCode = null;
    this.clearDeviceCodeTimer();
    if (!this.linked) {
      this.authCache.setWritesAllowed(false);
      void this.authCache.clearUnlinkedCaches().catch(() => undefined);
    }
    if (this.shuttingDown) return;

    if (this.linked && wasAutomatic && this.isServerOnline(this.latestState)) {
      this.status = 'reconnecting';
      this.message = 'Connexion Bedrock interrompue; N-Craft réessaiera sans demander de nouveau code Microsoft.';
      this.scheduleReconnect();
    } else {
      this.status = this.linked ? 'linked' : 'failed';
      this.message = this.linked
        ? 'Le profil dédié est conservé; le chatbot attend une nouvelle connexion Bedrock.'
        : 'La connexion Bedrock est terminée. Une nouvelle tentative exige une action explicite.';
    }
  }

  private releaseClient(client: BedrockProtocolClient, generation: number): void {
    if (generation !== this.connectionGeneration || this.currentClient !== client) return;
    this.connectionGeneration += 1;
    this.currentClient = null;
    this.currentAuthFlow = null;
    try { client.close('Chatbot connection ended.'); } catch { /* The client may already be closed. */ }
  }

  private closeCurrentClient(reason: string): void {
    this.connectionGeneration += 1;
    this.clearDeviceCodeTimer();
    const flow = this.currentAuthFlow as (AuthFlowLike & { msa?: AuthTokenManager }) | null;
    if (flow?.msa) flow.msa.polling = false;
    const client = this.currentClient;
    this.currentClient = null;
    this.currentAuthFlow = null;
    if (!client) return;
    try { client.disconnect(reason, true); } catch { /* Not yet connected. */ }
    try { client.close(reason); } catch { /* The client may already be closed. */ }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shuttingDown || !this.linked) return;
    const delay = Math.min(30_000, 5_000 * 2 ** Math.min(this.reconnectAttempt, 3));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.syncState(this.options.state.getSnapshot());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearDeviceCodeTimer(): void {
    if (this.deviceCodeTimer) clearTimeout(this.deviceCodeTimer);
    this.deviceCodeTimer = null;
  }
}
