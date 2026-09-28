import { createRequire } from 'node:module';
import type { VersionEntry } from '../../types/backend.ts';

const require = createRequire(import.meta.url);
const protocolOptions = require('bedrock-protocol/src/options.js') as {
  Versions: Record<string, number>;
};

/**
 * RakNet 11 / protocol 898 passed a local, offline client-to-server handshake
 * and chat-packet round trip with the pinned bedrock-protocol/raknet-node stack.
 * No other family is enabled until it has its own transport/protocol test.
 */
const TESTED_PROTOCOL_FAMILIES: Readonly<Record<string, number>> = Object.freeze({
  '1.21.130': 898,
});

export interface ChatbotProtocolAssessment {
  supported: boolean;
  build: string | null;
  clientVersion: string | null;
  protocolVersion: number | null;
  tested: boolean;
  reason: string;
}

export function assessChatbotProtocol(
  entry: Pick<VersionEntry, 'version' | 'clientVersion'> | null | undefined,
): ChatbotProtocolAssessment {
  if (!entry) {
    return {
      supported: false,
      build: null,
      clientVersion: null,
      protocolVersion: null,
      tested: false,
      reason: 'Déploie une version BDS avant d’activer le chatbot.',
    };
  }

  const protocolVersion = protocolOptions.Versions[entry.clientVersion] ?? null;
  const testedProtocol = TESTED_PROTOCOL_FAMILIES[entry.clientVersion];
  if (!testedProtocol || protocolVersion === null || protocolVersion !== testedProtocol) {
    return {
      supported: false,
      build: entry.version,
      clientVersion: entry.clientVersion,
      protocolVersion,
      tested: false,
      reason: `Le protocole client ${entry.clientVersion} n’est pas validé pour le chatbot.`,
    };
  }

  return {
    supported: true,
    build: entry.version,
    clientVersion: entry.clientVersion,
    protocolVersion,
    tested: true,
    reason: 'Famille validée en boucle locale avec RakNet 11 ; la compatibilité du binaire BDS officiel reste à confirmer.',
  };
}

export function getTestedProtocolFamilies(): Readonly<Record<string, number>> {
  return { ...TESTED_PROTOCOL_FAMILIES };
}
