import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

const COOKIE_NAME = 'nebula_panel_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const MAX_TRACKED_SESSIONS = 4096;

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export class PanelAuthService {
  private readonly expectedDigest: Buffer | null;
  private readonly sessions = new Map<string, number>();

  constructor(panelToken: string | undefined) {
    const token = panelToken?.trim();
    if (token === 'replace-with-a-long-random-token') {
      throw new Error('PANEL_TOKEN utilise encore le placeholder de .env.example ; remplace-le par un secret aléatoire.');
    }
    if (token && Buffer.byteLength(token, 'utf8') < 32) {
      console.warn('[auth] PANEL_TOKEN contient moins de 32 octets ; utilise un secret aléatoire plus long.');
    }
    this.expectedDigest = token ? tokenDigest(token) : null;
  }

  get configured(): boolean {
    return this.expectedDigest !== null;
  }

  verifyPanelToken(candidate: unknown): boolean {
    if (!this.expectedDigest || typeof candidate !== 'string') return false;
    // Hash both values first so timingSafeEqual always receives equal-length buffers.
    const candidateDigest = tokenDigest(candidate);
    return timingSafeEqual(this.expectedDigest, candidateDigest);
  }

  createSession(response: Response, request: Request): void {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(sessionId);
    }
    if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldestSession = this.sessions.keys().next().value as string | undefined;
      if (oldestSession) this.sessions.delete(oldestSession);
    }
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, now + SESSION_TTL_MS);
    this.setCookie(response, request, `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_TTL_SECONDS}`);
  }

  isAuthenticated(request: Request): boolean {
    const sessionId = readCookie(request, COOKIE_NAME);
    if (!sessionId) return false;
    const expiresAt = this.sessions.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  destroySession(request: Request, response: Response): void {
    const sessionId = readCookie(request, COOKIE_NAME);
    if (sessionId) this.sessions.delete(sessionId);
    this.setCookie(response, request, `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  requireAuthentication(): RequestHandler {
    return (request, response, next) => {
      if (!this.configured) {
        response.status(503).json({ error: 'PANEL_TOKEN n’est pas configuré dans l’environnement du conteneur.' });
        return;
      }
      if (!this.isAuthenticated(request)) {
        response.status(401).json({ error: 'Authentification requise.' });
        return;
      }
      next();
    };
  }

  private setCookie(response: Response, request: Request, value: string): void {
    // Production cookies are always Secure; the HTTPS middleware and proxy
    // trust configuration make a missing TLS hop fail closed instead.
    const secure = process.env.NODE_ENV === 'production' || request.secure;
    response.setHeader('Set-Cookie', `${value}${secure ? '; Secure' : ''}`);
  }
}
