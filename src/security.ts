import type { Request, RequestHandler } from 'express';
import type { IncomingHttpHeaders } from 'node:http';

export type ProxyTrustSetting = boolean | number | string[];

/** Parse a narrow, explicit Express trust-proxy setting. Wildcard trust is rejected. */
export function parseProxyTrust(value = process.env.PANEL_TRUST_PROXY): ProxyTrustSetting {
  const normalized = value?.trim();
  if (!normalized || normalized.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(normalized)) {
    const hops = Number(normalized);
    if (!Number.isSafeInteger(hops)) throw new Error('PANEL_TRUST_PROXY doit être un nombre sûr de hops.');
    return hops;
  }
  if (normalized.toLowerCase() === 'true' || normalized.includes('*')) {
    throw new Error('PANEL_TRUST_PROXY ne peut pas faire confiance à tous les proxies ; utilise un nombre de hops ou des IP/CIDR explicites.');
  }

  const proxies = normalized.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (proxies.length === 0) return false;
  return proxies;
}

function proxyTrustEnabled(): boolean {
  const setting = parseProxyTrust();
  return setting !== false && setting !== 0;
}

interface OriginRequest {
  headers: IncomingHttpHeaders;
  protocol?: string;
  socket?: { encrypted?: boolean };
  get?: (name: string) => string | undefined;
}

function header(request: OriginRequest, name: string): string | undefined {
  const fromExpress = request.get?.(name);
  if (fromExpress) return fromExpress;
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(request: OriginRequest | Request): boolean {
  const originRequest = request as OriginRequest;
  const configured = process.env.PANEL_ORIGIN?.trim();
  const trustForwardedHeaders = proxyTrustEnabled();
  const forwardedHost = trustForwardedHeaders
    ? header(originRequest, 'x-forwarded-host')?.split(',')[0]?.trim()
    : undefined;
  const host = forwardedHost || header(originRequest, 'host');
  const forwardedProto = trustForwardedHeaders
    ? header(originRequest, 'x-forwarded-proto')?.split(',')[0]?.trim()
    : undefined;
  // Express's protocol already respects the configured trust-proxy policy. Raw
  // WebSocket upgrade requests need the forwarded protocol fallback explicitly.
  const protocol = originRequest.protocol || forwardedProto || (originRequest.socket?.encrypted ? 'https' : 'http');
  const expected = normalizedOrigin(configured || (host ? `${protocol}://${host}` : undefined));

  // Modern browsers send Origin. Referer is accepted as a fallback for clients
  // that omit Origin, but an absent/opaque origin is rejected on every mutation.
  const originHeader = header(originRequest, 'origin');
  const candidate = originHeader !== undefined
    ? normalizedOrigin(originHeader)
    : normalizedOrigin(header(originRequest, 'referer'));
  return expected !== null && candidate !== null && candidate === expected;
}

/** In production, mutations and the UI are served only over a trusted HTTPS hop. */
export const requireHttpsInProduction: RequestHandler = (request, response, next) => {
  if (process.env.NODE_ENV === 'production' && !request.secure) {
    response.status(400).type('text/plain').send('HTTPS requis : configure une terminaison TLS et PANEL_TRUST_PROXY.');
    return;
  }
  next();
};

export const requireSameOrigin: RequestHandler = (request, response, next) => {
  if (!isSameOriginRequest(request)) {
    response.status(403).json({ error: 'Requête refusée : origine invalide (protection CSRF).' });
    return;
  }
  next();
};
