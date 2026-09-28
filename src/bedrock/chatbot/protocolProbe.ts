import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { VersionEntry } from '../../types/backend.ts';

const require = createRequire(import.meta.url);
const protocolOptions = require('bedrock-protocol/src/options.js') as {
  Versions: Record<string, number>;
};

/**
 * Packet-schema aliases used only by the offline compatibility probe. They do
 * not enable these versions in the production chatbot allowlist. The selected
 * BDS must still pass the real-server probe before N-Craft enables its family.
 */
const PROBE_CLIENT_ALIASES: Readonly<Record<string, { clientVersion: string; protocolVersion: number }>> = Object.freeze({
  // These hotfix releases retain the immediately preceding network protocol.
  '1.20.81': { clientVersion: '1.20.80', protocolVersion: 671 },
  '1.21.131': { clientVersion: '1.21.130', protocolVersion: 898 },
});

export interface ProtocolProbeTarget {
  supported: boolean;
  build: string;
  serverClientVersion: string;
  clientVersion: string | null;
  protocolVersion: number | null;
  usesAlias: boolean;
  reason: string;
}

export function resolveProtocolProbeTarget(
  entry: Pick<VersionEntry, 'version' | 'clientVersion'>,
): ProtocolProbeTarget {
  const directProtocol = protocolOptions.Versions[entry.clientVersion];
  if (Number.isSafeInteger(directProtocol) && directProtocol! > 0) {
    return {
      supported: true,
      build: entry.version,
      serverClientVersion: entry.clientVersion,
      clientVersion: entry.clientVersion,
      protocolVersion: directProtocol!,
      usesAlias: false,
      reason: 'Le client de test possède un schéma exact pour cette version.',
    };
  }

  const alias = PROBE_CLIENT_ALIASES[entry.clientVersion];
  if (alias && protocolOptions.Versions[alias.clientVersion] === alias.protocolVersion) {
    return {
      supported: true,
      build: entry.version,
      serverClientVersion: entry.clientVersion,
      clientVersion: alias.clientVersion,
      protocolVersion: alias.protocolVersion,
      usesAlias: true,
      reason: `Le client de test utilisera le schéma ${alias.clientVersion} du même protocole ${alias.protocolVersion}; seul l’essai contre ce BDS peut confirmer l’acceptation.`,
    };
  }

  return {
    supported: false,
    build: entry.version,
    serverClientVersion: entry.clientVersion,
    clientVersion: null,
    protocolVersion: null,
    usesAlias: false,
    reason: `Le client de test installé ne possède pas de schéma réseau vérifié pour Bedrock ${entry.clientVersion}.`,
  };
}

export interface ProbeClient {
  username?: string;
  on(event: string, listener: (...args: unknown[]) => void): this;
  init(): void | Promise<unknown>;
  connect(): void | Promise<unknown>;
  queue(name: string, packet: Record<string, unknown>): void;
  disconnect?(reason?: string, hide?: boolean): void;
  close?(reason?: string): void;
}

export type ProbeClientFactory = (options: Record<string, unknown>) => ProbeClient;

export interface ProtocolProbeResult {
  build: string;
  clientVersion: string;
  protocolVersion: number;
  markerRelayed: boolean;
}

export function createProbeChatPacket(message: string, sourceName: string): Record<string, unknown> {
  return {
    needs_translation: false,
    category: 'authored',
    chat: message,
    whisper: '',
    announcement: '',
    type: 'chat',
    source_name: sourceName,
    message,
    xuid: '0',
    platform_chat_id: '',
    has_filtered_message: false,
    filtered_message: '',
  };
}

function packetContainsMarker(packet: unknown, marker: string): boolean {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false;
  try {
    return JSON.stringify(packet).includes(marker);
  } catch {
    return false;
  }
}

/**
 * Connects two unauthenticated clients to a local, disposable official BDS,
 * sends an ordinary non-command chat line, and requires the other client to
 * receive its echo. It never requests Microsoft auth or calls an AI provider.
 */
export async function runChatbotBdsProtocolProbe(options: {
  entry: Pick<VersionEntry, 'version' | 'clientVersion'>;
  port: number;
  clientFactory: ProbeClientFactory;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ProtocolProbeResult> {
  const target = resolveProtocolProbeTarget(options.entry);
  if (!target.supported || !target.clientVersion || target.protocolVersion === null) {
    throw new Error(target.reason);
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65_535) {
    throw new Error('Le port de test doit être un entier entre 1024 et 65535.');
  }
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('Le délai de test doit être compris entre 1000 et 120000 ms.');
  }
  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    throw reason instanceof Error ? reason : new Error('Test de compatibilité annulé.');
  }

  const suffix = randomBytes(4).toString('hex');
  const marker = `NCRAFT-PROBE-${suffix}`;
  const senderName = `NCProbeA${suffix.slice(0, 4)}`;
  const receiverName = `NCProbeB${suffix.slice(0, 4)}`;
  const clients: ProbeClient[] = [];
  let timer: NodeJS.Timeout | null = null;

  try {
    const sender = options.clientFactory({
      host: '127.0.0.1',
      port: options.port,
      version: target.clientVersion,
      username: senderName,
      offline: true,
      raknetBackend: 'raknet-node',
      useRaknetWorkers: false,
      skipPing: true,
      connectTimeout: timeoutMs,
      conLog: () => undefined,
      delayedInit: true,
    });
    clients.push(sender);
    const receiver = options.clientFactory({
      host: '127.0.0.1',
      port: options.port,
      version: target.clientVersion,
      username: receiverName,
      offline: true,
      raknetBackend: 'raknet-node',
      useRaknetWorkers: false,
      skipPing: true,
      connectTimeout: timeoutMs,
      conLog: () => undefined,
      delayedInit: true,
    });
    clients.push(receiver);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const spawned = new Set<ProbeClient>();
      let messageSent = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        const reason = options.signal?.reason;
        finish(reason instanceof Error ? reason : new Error('Test de compatibilité annulé.'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => finish(new Error(`Aucun aller-retour du message de test sur 127.0.0.1:${options.port}; vérifie que le BDS temporaire est démarré sur ce port.`)), timeoutMs);

      receiver.on('text', (packet) => {
        if (packetContainsMarker(packet, marker)) finish();
      });

      for (const client of clients) {
        client.on('error', () => finish(new Error('Un client de test n’a pas pu se connecter au BDS local.')));
        client.on('kick', () => finish(new Error('Le BDS a refusé un client de test hors ligne.')));
        client.on('close', () => finish(new Error('La connexion au BDS a été fermée avant le test de chat.')));
        client.on('connect_allowed', () => {
          try {
            void Promise.resolve(client.connect()).catch(() => {
              finish(new Error(`Impossible de joindre le BDS temporaire sur 127.0.0.1:${options.port}; vérifie qu’il est démarré et que son port correspond.`));
            });
          } catch {
            finish(new Error(`Impossible de joindre le BDS temporaire sur 127.0.0.1:${options.port}; vérifie qu’il est démarré et que son port correspond.`));
          }
        });
        client.on('spawn', () => {
          spawned.add(client);
          if (spawned.size !== clients.length || messageSent) return;
          messageSent = true;
          try {
            sender.queue('text', createProbeChatPacket(marker, senderName));
          } catch {
            finish(new Error('Impossible d’envoyer le message de test au BDS local.'));
          }
        });
      }

      try {
        for (const client of clients) {
          void Promise.resolve(client.init()).catch(() => {
            finish(new Error(`Impossible de joindre le BDS temporaire sur 127.0.0.1:${options.port}; vérifie qu’il est démarré et que son port correspond.`));
          });
        }
      } catch {
        finish(new Error('Impossible de démarrer les clients de test Bedrock.'));
      }
    });

    return {
      build: target.build,
      clientVersion: target.clientVersion,
      protocolVersion: target.protocolVersion,
      markerRelayed: true,
    };
  } finally {
    if (timer) clearTimeout(timer);
    for (const client of clients) {
      try { client.disconnect?.('Fin du test de compatibilité.', true); } catch { /* already disconnected */ }
      try { client.close?.('Fin du test de compatibilité.'); } catch { /* already closed */ }
    }
  }
}
