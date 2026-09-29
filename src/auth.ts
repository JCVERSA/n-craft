import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import type { PanelRole, PanelUserSummary } from './types/backend.ts';

const COOKIE_NAME = 'nebula_panel_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const MAX_TRACKED_SESSIONS = 4096;
const USER_STORE_SCHEMA = 1;
const ROLE_WEIGHT: Record<PanelRole, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };
const USER_ROLES = new Set<PanelRole>(['admin', 'operator', 'viewer']);

interface StoredPanelUser {
  id: string;
  username: string;
  role: Exclude<PanelRole, 'owner'>;
  createdAt: string;
  salt: string;
  passwordHash: string;
}

interface StoredUsers {
  schemaVersion: number;
  users: StoredPanelUser[];
}

export interface PanelPrincipal {
  username: string;
  role: PanelRole;
  userId: string | null;
}

interface PanelSession {
  expiresAt: number;
  principal: PanelPrincipal;
}

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

function normalizedUsername(username: string): string {
  return username.toLocaleLowerCase('en-US');
}

function validateUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(value)) {
    throw new Error('Le nom de compte doit contenir 3 à 32 lettres, chiffres, points, tirets ou soulignés.');
  }
  return value;
}

function validateUserRole(value: unknown): Exclude<PanelRole, 'owner'> {
  if (typeof value !== 'string' || !USER_ROLES.has(value as PanelRole)) {
    throw new Error('Le rôle doit être admin, operator ou viewer ; owner est réservé au jeton PANEL_TOKEN.');
  }
  return value as Exclude<PanelRole, 'owner'>;
}

function publicUser(user: StoredPanelUser): PanelUserSummary {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

async function assertNoSymlinkInPath(directory: string): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Le chemin des comptes panneau contient un lien symbolique : ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export class PanelAuthService {
  private readonly expectedDigest: Buffer | null;
  private readonly sessions = new Map<string, PanelSession>();
  private users: StoredPanelUser[] = [];
  private userMutationQueue: Promise<void> = Promise.resolve();
  private readonly usersFilePath: string | null;

  constructor(panelToken: string | undefined, dataDirectory?: string) {
    const token = panelToken?.trim();
    if (token === 'replace-with-a-long-random-token') {
      throw new Error('PANEL_TOKEN utilise encore le placeholder de .env.example ; remplace-le par un secret aléatoire.');
    }
    if (token && Buffer.byteLength(token, 'utf8') < 32) {
      console.warn('[auth] PANEL_TOKEN contient moins de 32 octets ; utilise un secret aléatoire plus long.');
    }
    this.expectedDigest = token ? tokenDigest(token) : null;
    this.usersFilePath = dataDirectory ? path.join(dataDirectory, 'panel-users.json') : null;
  }

  async initialize(): Promise<void> {
    if (!this.usersFilePath) return;
    await assertNoSymlinkInPath(path.dirname(this.usersFilePath));
    await mkdir(path.dirname(this.usersFilePath), { recursive: true, mode: 0o700 });
    const info = await lstat(this.usersFilePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Le magasin des utilisateurs du panneau n’est pas un fichier ordinaire.');
    const parsed = JSON.parse(await readFile(this.usersFilePath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Le magasin des utilisateurs du panneau est invalide.');
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== USER_STORE_SCHEMA || !Array.isArray(record.users) || record.users.length > 256) {
      throw new Error('Le magasin des utilisateurs du panneau utilise un schéma invalide.');
    }
    const users = record.users.map((value, index): StoredPanelUser => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Compte panneau #${index + 1} invalide.`);
      const user = value as Record<string, unknown>;
      const username = validateUsername(user.username);
      const role = validateUserRole(user.role);
      if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)
        || typeof user.createdAt !== 'string' || Number.isNaN(Date.parse(user.createdAt))
        || typeof user.salt !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(user.salt)
        || typeof user.passwordHash !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(user.passwordHash)) {
        throw new Error(`Identifiants du compte panneau #${index + 1} invalides.`);
      }
      return { id: user.id, username, role, createdAt: user.createdAt, salt: user.salt, passwordHash: user.passwordHash };
    });
    if (new Set(users.map((user) => normalizedUsername(user.username))).size !== users.length) {
      throw new Error('Le magasin des utilisateurs contient des noms en double.');
    }
    this.users = users;
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

  async authenticate(credentials: { token?: unknown; username?: unknown; password?: unknown }): Promise<PanelPrincipal | null> {
    if (!this.configured) return null;
    if (typeof credentials.token === 'string' && credentials.token.length <= 4096 && this.verifyPanelToken(credentials.token)) {
      return { username: 'owner', role: 'owner', userId: null };
    }
    if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string'
      || credentials.username.length > 32 || credentials.password.length < 1 || credentials.password.length > 128) return null;
    const user = this.users.find((candidate) => normalizedUsername(candidate.username) === normalizedUsername(credentials.username as string));
    if (!user) return null;
    let computed: Buffer;
    try {
      computed = scryptSync(credentials.password, Buffer.from(user.salt, 'base64url'), 64);
    } catch {
      return null;
    }
    const expected = Buffer.from(user.passwordHash, 'base64url');
    if (computed.length !== expected.length || !timingSafeEqual(computed, expected)) return null;
    return { username: user.username, role: user.role, userId: user.id };
  }

  createSession(response: Response, request: Request, principal: PanelPrincipal = { username: 'owner', role: 'owner', userId: null }): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
    if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldestSession = this.sessions.keys().next().value as string | undefined;
      if (oldestSession) this.sessions.delete(oldestSession);
    }
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, { expiresAt: now + SESSION_TTL_MS, principal: { ...principal } });
    this.setCookie(response, request, `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_TTL_SECONDS}`);
  }

  getPrincipal(request: Request): PanelPrincipal | null {
    const sessionId = readCookie(request, COOKIE_NAME);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return { ...session.principal };
  }

  isAuthenticated(request: Request): boolean {
    return this.getPrincipal(request) !== null;
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

  /** Requires the requested minimum rank in the owner > admin > operator > viewer hierarchy. */
  requireRole(minimumRole: PanelRole): RequestHandler {
    const requireAuth = this.requireAuthentication();
    return (request, response, next) => requireAuth(request, response, (error?: unknown) => {
      if (error) return next(error);
      const principal = this.getPrincipal(request);
      if (!principal || ROLE_WEIGHT[principal.role] < ROLE_WEIGHT[minimumRole]) {
        response.status(403).json({ error: `Rôle ${minimumRole} ou supérieur requis pour cette action.` });
        return;
      }
      next();
    });
  }

  listUsers(): PanelUserSummary[] {
    return this.users.map(publicUser);
  }

  private mutateUsers<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.userMutationQueue.then(operation, operation);
    this.userMutationQueue = current.then(() => undefined, () => undefined);
    return current;
  }

  async createUser(usernameInput: unknown, password: unknown, roleInput: unknown): Promise<PanelUserSummary> {
    return this.mutateUsers(async () => {
      const username = validateUsername(usernameInput);
      const role = validateUserRole(roleInput);
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
        throw new Error('Le mot de passe doit contenir entre 12 et 128 caractères.');
      }
      if (this.users.some((user) => normalizedUsername(user.username) === normalizedUsername(username))) {
        throw new Error('Un compte avec ce nom existe déjà.');
      }
      const salt = randomBytes(16);
      const user: StoredPanelUser = {
        id: randomUUID(),
        username,
        role,
        createdAt: new Date().toISOString(),
        salt: salt.toString('base64url'),
        passwordHash: scryptSync(password, salt, 64).toString('base64url'),
      };
      this.users = [...this.users, user];
      try {
        await this.persistUsers();
      } catch (error) {
        this.users = this.users.filter((candidate) => candidate.id !== user.id);
        throw error;
      }
      return publicUser(user);
    });
  }

  async updateUserRole(id: string, roleInput: unknown): Promise<PanelUserSummary> {
    return this.mutateUsers(async () => {
      const role = validateUserRole(roleInput);
      const existing = this.users.find((user) => user.id === id);
      if (!existing) throw new Error('Compte panneau introuvable.');
      const before = this.users;
      this.users = this.users.map((user) => user.id === id ? { ...user, role } : user);
      try {
        await this.persistUsers();
      } catch (error) {
        this.users = before;
        throw error;
      }
      for (const session of this.sessions.values()) {
        if (session.principal.userId === id) session.principal.role = role;
      }
      return publicUser(this.users.find((user) => user.id === id)!);
    });
  }

  async deleteUser(id: string): Promise<void> {
    return this.mutateUsers(async () => {
      const before = this.users;
      const next = before.filter((user) => user.id !== id);
      if (next.length === before.length) throw new Error('Compte panneau introuvable.');
      this.users = next;
      try {
        await this.persistUsers();
      } catch (error) {
        this.users = before;
        throw error;
      }
      for (const [sessionId, session] of this.sessions) {
        if (session.principal.userId === id) this.sessions.delete(sessionId);
      }
    });
  }

  private async persistUsers(): Promise<void> {
    if (!this.usersFilePath) throw new Error('Le stockage des comptes n’est pas initialisé.');
    await assertNoSymlinkInPath(path.dirname(this.usersFilePath));
    await mkdir(path.dirname(this.usersFilePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.usersFilePath}.${randomUUID()}.tmp`;
    const data: StoredUsers = { schemaVersion: USER_STORE_SCHEMA, users: this.users };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.usersFilePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private setCookie(response: Response, request: Request, value: string): void {
    // Production cookies are always Secure; the HTTPS middleware and proxy
    // trust configuration make a missing TLS hop fail closed instead.
    const secure = process.env.NODE_ENV === 'production' || request.secure;
    response.setHeader('Set-Cookie', `${value}${secure ? '; Secure' : ''}`);
  }
}
