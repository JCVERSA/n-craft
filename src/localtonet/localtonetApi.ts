import { isIP } from 'node:net';

export interface LocaltonetTunnelEndpoint {
  address: string;
  connected: boolean;
  id: string | null;
  title: string | null;
}

interface LocaltonetTunnelRecord {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  serverDomain?: unknown;
  serverIp?: unknown;
  serverPort?: unknown;
  clientPort?: unknown;
  protocolType?: unknown;
  connectionStatus?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function formatAddress(tunnel: LocaltonetTunnelRecord): string | null {
  const rawEndpoint = [tunnel.url, tunnel.serverDomain, tunnel.serverIp]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
  if (!rawEndpoint) return null;

  const fallbackPort = readPort(tunnel.serverPort);
  let normalized = rawEndpoint.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
  if (isIP(normalized) === 6) normalized = `[${normalized}]`;
  try {
    const parsed = new URL(`udp://${normalized}`);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!hostname) return null;
    const port = readPort(parsed.port) ?? fallbackPort;
    if (!port) return null;
    const displayHost = hostname.includes(':') ? `[${hostname}]` : hostname;
    return `${displayHost}:${port}`;
  } catch {
    return null;
  }
}

/** Extracts the one configured Bedrock UDP tunnel from Localtonet's API response. */
export function findBedrockUdpTunnel(payload: unknown, localPort = 19132): LocaltonetTunnelEndpoint | null {
  const tunnels = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.tunnels)
      ? payload.tunnels
      : null;
  if (!tunnels) throw new Error('La réponse de l’API Localtonet n’a pas le format attendu.');

  const expectedPort = readPort(localPort);
  if (!expectedPort) throw new Error('Le port local Bedrock configuré est invalide.');

  const matches = tunnels
    .filter(isRecord)
    .map((record) => record as LocaltonetTunnelRecord)
    .filter((record) => {
      const protocol = record.protocolType;
      const supportsUdp = (typeof protocol === 'string' && (/udp/i.test(protocol) || ['2', '4'].includes(protocol)))
        || protocol === 2
        || protocol === 4;
      return supportsUdp && readPort(record.clientPort) === expectedPort;
    })
    .map((record) => ({
      record,
      address: formatAddress(record),
    }))
    .filter((candidate): candidate is { record: LocaltonetTunnelRecord; address: string } => candidate.address !== null);

  if (matches.length === 0) return null;
  const connected = matches.filter(({ record }) => record.connectionStatus === true);
  const selected = connected.length === 1 ? connected[0] : matches.length === 1 ? matches[0] : null;
  if (!selected) throw new Error('Plusieurs tunnels UDP locaux sur le port 19132 existent. Garde un seul tunnel Bedrock actif pour cette instance.');

  return {
    address: selected.address,
    connected: selected.record.connectionStatus === true,
    id: typeof selected.record.id === 'string' || typeof selected.record.id === 'number' ? String(selected.record.id) : null,
    title: typeof selected.record.title === 'string' ? selected.record.title : null,
  };
}

export interface LocaltonetApiOptions {
  apiBaseUrl?: string;
  apiKey: string;
  authToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Reads only the tunnel assigned to this device token; credentials never enter the response model. */
export async function fetchBedrockTunnel(options: LocaltonetApiOptions): Promise<LocaltonetTunnelEndpoint | null> {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://localtonet.com').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiBaseUrl}/api/v2/auth-tokens/${encodeURIComponent(options.authToken)}/tunnels`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        signal: controller.signal,
        cache: 'no-store',
      },
    );
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? 'délai dépassé'
      : 'connexion impossible';
    throw new Error(`API Localtonet : ${reason}. Vérifie la sortie HTTPS du conteneur.`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Clé API Localtonet refusée. Vérifie LOCALTONET_API_KEY dans l’environnement du conteneur.');
  }
  if (!response.ok) {
    throw new Error(`API Localtonet indisponible (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error('L’API Localtonet a renvoyé une réponse JSON invalide.');
  }
  return findBedrockUdpTunnel(payload);
}
