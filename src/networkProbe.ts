import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createSocket, type RemoteInfo, type SocketType } from 'node:dgram';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { BedrockConsole } from './bedrock/console.ts';
import type { StateStore } from './state.ts';
import type { NetworkProbeResult, TunnelProvider } from './types/backend.ts';

const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const DEFAULT_BEDROCK_PORT = 19_132;
const PROBE_TIMEOUT_MS = 3_500;

export interface BedrockEndpoint {
  host: string;
  port: number;
}

export function parseBedrockEndpoint(value: string, defaultPort = DEFAULT_BEDROCK_PORT): BedrockEndpoint | null {
  const candidate = value.trim();
  if (!candidate || candidate.length > 255 || /[\s/@?#]/.test(candidate) || candidate.includes('://')) return null;
  let host = '';
  let port = defaultPort;
  if (candidate.startsWith('[')) {
    const close = candidate.indexOf(']');
    if (close < 0) return null;
    host = candidate.slice(1, close);
    const suffix = candidate.slice(close + 1);
    if (suffix) {
      if (!suffix.startsWith(':') || !/^:\d+$/.test(suffix)) return null;
      port = Number(suffix.slice(1));
    }
  } else {
    const firstColon = candidate.indexOf(':');
    const lastColon = candidate.lastIndexOf(':');
    if (firstColon >= 0 && firstColon === lastColon) {
      host = candidate.slice(0, firstColon);
      const portText = candidate.slice(firstColon + 1);
      if (!/^\d+$/.test(portText)) return null;
      port = Number(portText);
    } else {
      host = candidate;
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (isIP(host) === 0 && !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/.test(host)) return null;
  return { host, port };
}

export function buildRakNetUnconnectedPing(timestamp = BigInt(Date.now()), clientGuid = randomBytes(8)): Buffer {
  if (clientGuid.byteLength !== 8) throw new Error('RakNet GUID must contain 8 bytes.');
  const packet = Buffer.alloc(1 + 8 + RAKNET_MAGIC.length + 8);
  packet[0] = 0x01;
  packet.writeBigInt64BE(timestamp, 1);
  RAKNET_MAGIC.copy(packet, 9);
  clientGuid.copy(packet, 9 + RAKNET_MAGIC.length);
  return packet;
}

export function parseRakNetUnconnectedPong(packet: Buffer, expectedTimestamp?: bigint): string | null {
  const fixedLength = 1 + 8 + 8 + RAKNET_MAGIC.length + 2;
  if (packet.length < fixedLength || packet[0] !== 0x1c) return null;
  const timestamp = packet.readBigInt64BE(1);
  if (expectedTimestamp !== undefined && timestamp !== expectedTimestamp) return null;
  const magicOffset = 1 + 8 + 8;
  if (!packet.subarray(magicOffset, magicOffset + RAKNET_MAGIC.length).equals(RAKNET_MAGIC)) return null;
  const lengthOffset = magicOffset + RAKNET_MAGIC.length;
  const nameLength = packet.readUInt16BE(lengthOffset);
  if (lengthOffset + 2 + nameLength > packet.length) return null;
  return packet.subarray(lengthOffset + 2, lengthOffset + 2 + nameLength).toString('utf8').replace(/[\0-\x1f\x7f]/g, '').slice(0, 512);
}

export async function probeRakNetEndpoint(endpoint: BedrockEndpoint, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ latencyMs: number; serverName: string | null }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) throw new Error('UDP probe timeout is invalid.');
  const hostFamily = isIP(endpoint.host);
  const resolved = hostFamily === 4 || hostFamily === 6
    ? [{ address: endpoint.host, family: hostFamily }]
    : await lookup(endpoint.host, { all: true, verbatim: true });
  const destination = resolved.find((entry) => entry.family === 4) ?? resolved[0];
  if (!destination) throw new Error('Could not resolve UDP probe destination.');
  const socketType: SocketType = destination.family === 6 ? 'udp6' : 'udp4';
  const socket = createSocket(socketType);
  const timestamp = BigInt(Date.now());
  const requestPacket = buildRakNetUnconnectedPing(timestamp);
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: { latencyMs: number; serverName: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('message');
      socket.removeAllListeners('error');
      try { socket.close(); } catch { /* It may not be bound yet. */ }
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Aucune réponse RakNet dans le délai imparti.')), timeoutMs);
    timer.unref?.();
    socket.once('error', (error) => finish(error));
    socket.on('message', (message: Buffer, remote: RemoteInfo) => {
      if (remote.port !== endpoint.port || remote.address !== destination.address) return;
      const serverName = parseRakNetUnconnectedPong(message, timestamp);
      if (serverName === null) return;
      finish(undefined, { latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), serverName: serverName || null });
    });
    socket.send(requestPacket, endpoint.port, destination.address, (error) => {
      if (error) finish(error);
    });
  });
}

export class BedrockNetworkMonitor {
  private readonly activeProbes = new Map<'local' | 'tunnel', Promise<NetworkProbeResult>>();

  constructor(
    private readonly state: StateStore,
    private readonly bedrockConsole: BedrockConsole,
    private readonly tunnelProvider: TunnelProvider,
  ) {}

  probe(source: 'local' | 'tunnel'): Promise<NetworkProbeResult> {
    const active = this.activeProbes.get(source);
    if (active) return active;
    const operation = this.runProbe(source).finally(() => {
      if (this.activeProbes.get(source) === operation) this.activeProbes.delete(source);
    });
    this.activeProbes.set(source, operation);
    return operation;
  }

  private async runProbe(source: 'local' | 'tunnel'): Promise<NetworkProbeResult> {
    const checkedAt = new Date().toISOString();
    const server = this.state.getSnapshot().server;
    if (server.status !== 'running' || !this.bedrockConsole.isReady) {
      return {
        status: 'server-stopped',
        source,
        target: source === 'local' ? '127.0.0.1:19132' : null,
        latencyMs: null,
        serverName: null,
        checkedAt,
        message: 'Bedrock n’est pas prêt ; le test UDP n’a pas été envoyé.',
      };
    }

    const endpoint = source === 'local'
      ? { host: '127.0.0.1', port: DEFAULT_BEDROCK_PORT }
      : this.getTunnelEndpoint();
    if (!endpoint) {
      return {
        status: 'unconfigured', source, target: null, latencyMs: null, serverName: null, checkedAt,
        message: 'Aucune adresse Bedrock publique exploitable n’est connue pour le tunnel actif.',
      };
    }
    const target = `${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
    try {
      const result = await probeRakNetEndpoint(endpoint);
      return {
        status: 'reachable', source, target, latencyMs: result.latencyMs, serverName: result.serverName, checkedAt,
        message: source === 'local'
          ? 'Réponse RakNet reçue sur loopback dans le conteneur.'
          : 'Réponse RakNet reçue via l’adresse publique du tunnel depuis le conteneur. Ce test n’est pas une sonde indépendante depuis un autre réseau.',
      };
    } catch {
      return {
        status: 'unreachable', source, target, latencyMs: null, serverName: null, checkedAt,
        message: source === 'local'
          ? 'Aucune réponse UDP/RakNet sur 127.0.0.1:19132 ; vérifie le serveur et le port UDP.'
          : 'Aucune réponse via l’adresse publique du tunnel depuis le conteneur. Le résultat peut dépendre du NAT loopback et ne prouve pas la joignabilité depuis tous les réseaux externes.',
      };
    }
  }

  private getTunnelEndpoint(): BedrockEndpoint | null {
    const snapshot = this.state.getSnapshot();
    const address = this.tunnelProvider === 'portwarp'
      ? snapshot.portwarp.address
      : this.tunnelProvider === 'playit'
        ? snapshot.playit.address
        : snapshot.localtonet.address;
    return address ? parseBedrockEndpoint(address) : null;
  }
}
