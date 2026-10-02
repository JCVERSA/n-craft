import { Router, type RequestHandler, type Response } from 'express';
import type { PanelAuthService } from '../auth.ts';
import { requireSameOrigin } from '../security.ts';
import { PixelStudioAIError, PixelStudioAIService } from '../pixelStudio/aiService.ts';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

function createGenerationRateLimit(): RequestHandler {
  const attempts = new Map<string, RateLimitEntry>();
  const maxTrackedAddresses = 512;
  const limit = 8;
  const windowMs = 10 * 60_000;

  return (request, response, next) => {
    const now = Date.now();
    for (const [address, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(address);
    }

    const address = request.ip || request.socket.remoteAddress || 'unknown';
    const previous = attempts.get(address);
    const entry = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + windowMs } : previous;
    if (entry.count >= limit) {
      response.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      response.status(429).json({ error: 'Limite de génération atteinte. Réessaie dans quelques minutes.' });
      return;
    }
    if (!previous && attempts.size >= maxTrackedAddresses) {
      const oldestAddress = attempts.keys().next().value as string | undefined;
      if (oldestAddress) attempts.delete(oldestAddress);
    }
    attempts.delete(address);
    entry.count += 1;
    attempts.set(address, entry);
    next();
  };
}

function sendAIError(error: unknown, response: Response): void {
  if (error instanceof PixelStudioAIError) {
    const status = error.code === 'invalid_request' ? 400
      : error.code === 'not_configured' ? 503
        : error.code === 'busy' ? 409 : 502;
    response.status(status).json({ error: error.message });
    return;
  }
  response.status(500).json({ error: 'La génération a échoué. Réessaie plus tard.' });
}

export function createPixelStudioRouter(auth: PanelAuthService, ai: PixelStudioAIService): Router {
  const router = Router();
  const requireOperator = auth.requireRole('operator');
  const generationRateLimit = createGenerationRateLimit();
  router.use(auth.requireAuthentication());

  router.get('/status', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(ai.getStatus());
  });

  router.post('/generate', requireOperator, requireSameOrigin, generationRateLimit, async (request, response) => {
    try {
      const result = await ai.generateMatrix({ prompt: request.body?.prompt });
      response.setHeader('Cache-Control', 'no-store');
      response.json({ matrix: result.result, provider: result.provider, gridSize: 16 });
    } catch (error) {
      sendAIError(error, response);
    }
  });

  router.post('/animate', requireOperator, requireSameOrigin, generationRateLimit, async (request, response) => {
    try {
      const result = await ai.generateAnimation({
        prompt: request.body?.prompt,
        animationType: request.body?.animationType,
        frameCount: request.body?.frameCount,
        currentMatrix: request.body?.currentMatrix,
      });
      response.setHeader('Cache-Control', 'no-store');
      response.json({ frames: result.result, provider: result.provider, gridSize: 16 });
    } catch (error) {
      sendAIError(error, response);
    }
  });

  return router;
}
