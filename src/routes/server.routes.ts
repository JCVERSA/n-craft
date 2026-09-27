import { Router } from 'express';
import type { PanelAuthService } from '../auth.ts';
import { DeployInProgressError, DeployPipeline } from '../bedrock/deployPipeline.ts';
import { ConfigurationError, validateDeployConfiguration } from '../bedrock/configWriter.ts';
import { BedrockConsole } from '../bedrock/console.ts';
import type { StateStore } from '../state.ts';
import { requireSameOrigin } from '../security.ts';
import { SystemInspector } from '../preflight.ts';
import { VersionCatalog } from '../versionCatalog.ts';

export interface ServerRouteDependencies {
  auth: PanelAuthService;
  state: StateStore;
  pipeline: DeployPipeline;
  bedrockConsole: BedrockConsole;
  inspector: SystemInspector;
  catalog: VersionCatalog;
}

export function createServerRouter(dependencies: ServerRouteDependencies): Router {
  const router = Router();
  router.use(dependencies.auth.requireAuthentication());

  router.get('/status', async (_request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      const [system] = await Promise.all([dependencies.inspector.inspect()]);
      response.json({
        state: dependencies.state.getSnapshot(),
        system,
        serverDirectory: dependencies.pipeline.serverDirectoryPath,
        deployBusy: dependencies.pipeline.isRunning,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/versions', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ versions: dependencies.catalog.publicEntries() });
  });

  router.get('/logs', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ lines: dependencies.bedrockConsole.getRecentLines() });
  });

  router.post('/deploy', requireSameOrigin, (request, response) => {
    try {
      const config = validateDeployConfiguration(request.body?.config, dependencies.catalog.allowedVersionIds());
      dependencies.pipeline.start(config);
      response.status(202).json({
        accepted: true,
        state: dependencies.state.getSnapshot(),
      });
    } catch (error) {
      if (error instanceof DeployInProgressError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof ConfigurationError) {
        response.status(400).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la demande de déploiement.' });
    }
  });

  router.post('/stop', requireSameOrigin, async (_request, response) => {
    try {
      await dependencies.pipeline.stop();
      response.status(200).json({
        stopped: true,
        state: dependencies.state.getSnapshot(),
      });
    } catch (error) {
      if (error instanceof DeployInProgressError) {
        response.status(409).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de l’arrêt du serveur.' });
    }
  });

  return router;
}
