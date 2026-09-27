import { Router } from 'express';
import type { PanelAuthService } from '../auth.ts';
import { requireSameOrigin } from '../security.ts';

interface LoginAttempt {
  count: number;
  resetAt: number;
}

export function createAuthRouter(auth: PanelAuthService): Router {
  const router = Router();
  const attempts = new Map<string, LoginAttempt>();
  const maxTrackedAddresses = 2048;
  const requireAuth = auth.requireAuthentication();

  router.get('/status', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      configured: auth.configured,
      authenticated: auth.isAuthenticated(request),
    });
  });

  router.post('/login', requireSameOrigin, (request, response) => {
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

    const token = request.body && typeof request.body.token === 'string' ? request.body.token : '';
    if (token.length > 4096 || !auth.verifyPanelToken(token)) {
      response.status(401).json({ error: 'Jeton invalide.' });
      return;
    }

    attempts.delete(key);
    auth.createSession(response, request);
    response.status(200).json({ authenticated: true });
  });

  router.post('/logout', requireAuth, requireSameOrigin, (request, response) => {
    auth.destroySession(request, response);
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({ authenticated: false });
  });

  return router;
}
