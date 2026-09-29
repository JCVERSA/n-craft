import { Router } from 'express';
import type { PanelAuthService } from '../auth.ts';
import type { AuditLog } from '../audit.ts';
import { requireSameOrigin } from '../security.ts';

interface LoginAttempt {
  count: number;
  resetAt: number;
}

export function createAuthRouter(auth: PanelAuthService, audit?: AuditLog): Router {
  const router = Router();
  const attempts = new Map<string, LoginAttempt>();
  const maxTrackedAddresses = 2048;
  const requireAuth = auth.requireAuthentication();
  const requireOwner = auth.requireRole('owner');

  const record = async (principal: ReturnType<PanelAuthService['getPrincipal']>, action: string, detail: string) => {
    if (audit) await audit.record(principal, action, detail).catch(() => undefined);
  };

  router.get('/status', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const principal = auth.getPrincipal(request);
    response.json({
      configured: auth.configured,
      authenticated: principal !== null,
      role: principal?.role ?? null,
      username: principal?.username ?? null,
    });
  });

  router.post('/login', requireSameOrigin, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!auth.configured) {
      response.status(503).json({ error: 'PANEL_TOKEN n’est pas configuré dans le conteneur.' });
      return;
    }

    const key = request.ip || request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    for (const [address, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(address);
    }

    const prior = attempts.get(key);
    const attempt = !prior || prior.resetAt <= now ? { count: 0, resetAt: now + 5 * 60_000 } : prior;
    if (attempt.count >= 10) {
      response.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });
      return;
    }
    if (!prior && attempts.size >= maxTrackedAddresses) {
      // Bound memory even if incoming forwarded IPs are forged or highly varied.
      const oldestAddress = attempts.keys().next().value as string | undefined;
      if (oldestAddress) attempts.delete(oldestAddress);
    }
    attempts.delete(key);
    attempt.count += 1;
    attempts.set(key, attempt);

    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const principal = await auth.authenticate({ token: body.token, username: body.username, password: body.password });
    if (!principal) {
      response.status(401).json({ error: 'Identifiants invalides.' });
      return;
    }

    attempts.delete(key);
    auth.createSession(response, request, principal);
    await record(principal, 'panel-login', 'Connexion au panneau.');
    response.status(200).json({ authenticated: true, username: principal.username, role: principal.role });
  });

  router.post('/logout', requireAuth, requireSameOrigin, async (request, response) => {
    const principal = auth.getPrincipal(request);
    auth.destroySession(request, response);
    if (principal) await record(principal, 'panel-logout', 'Déconnexion du panneau.');
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({ authenticated: false });
  });

  router.get('/users', requireOwner, (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ users: auth.listUsers() });
  });

  router.post('/users', requireOwner, requireSameOrigin, async (request, response) => {
    try {
      const user = await auth.createUser(request.body?.username, request.body?.password, request.body?.role);
      const principal = auth.getPrincipal(request);
      await record(principal, 'panel-user-created', `Compte ${user.username} créé avec le rôle ${user.role}.`);
      response.status(201).json({ user });
    } catch (error) {
      response.status(400).json({ error: (error as Error).message || 'Impossible de créer ce compte.' });
    }
  });

  router.patch('/users/:id', requireOwner, requireSameOrigin, async (request, response) => {
    try {
      const user = await auth.updateUserRole(request.params.id, request.body?.role);
      const principal = auth.getPrincipal(request);
      await record(principal, 'panel-user-role-changed', `Rôle de ${user.username} défini sur ${user.role}.`);
      response.json({ user });
    } catch (error) {
      response.status(400).json({ error: (error as Error).message || 'Impossible de modifier ce compte.' });
    }
  });

  router.delete('/users/:id', requireOwner, requireSameOrigin, async (request, response) => {
    try {
      const user = auth.listUsers().find((candidate) => candidate.id === request.params.id);
      if (!user) throw new Error('Compte panneau introuvable.');
      await auth.deleteUser(user.id);
      const principal = auth.getPrincipal(request);
      await record(principal, 'panel-user-deleted', `Compte ${user.username} supprimé; ses sessions ont été révoquées.`);
      response.json({ deleted: true, id: user.id });
    } catch (error) {
      response.status(400).json({ error: (error as Error).message || 'Impossible de supprimer ce compte.' });
    }
  });

  return router;
}
