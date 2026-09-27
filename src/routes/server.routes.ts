import { Router } from 'express';
import type { PanelAuthService } from '../auth.ts';
import { DeployInProgressError, DeployPipeline, ServerNotInstalledError } from '../bedrock/deployPipeline.ts';
import { ConfigurationError, validateDeployConfiguration } from '../bedrock/configWriter.ts';
import { BedrockConsole } from '../bedrock/console.ts';
import type { BedrockRestartScheduler } from '../bedrock/scheduler.ts';
import type { StateStore } from '../state.ts';
import { requireSameOrigin } from '../security.ts';
import { SystemInspector } from '../preflight.ts';
import { VersionCatalog } from '../versionCatalog.ts';
import type { PlayitRunner } from '../playit/playitRunner.ts';
import type { PortwarpRunner } from '../portwarp/portwarpRunner.ts';
import type { TunnelProvider } from '../types/backend.ts';

export interface ServerRouteDependencies {
  auth: PanelAuthService;
  state: StateStore;
  pipeline: DeployPipeline;
  bedrockConsole: BedrockConsole;
  scheduler: BedrockRestartScheduler;
  inspector: SystemInspector;
  catalog: VersionCatalog;
  playitRunner: PlayitRunner;
  portwarpRunner: PortwarpRunner;
  tunnelProvider: TunnelProvider;
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
        tunnelProvider: dependencies.tunnelProvider,
        playitSetup: dependencies.playitRunner.getSetupSnapshot(),
        portwarpSetup: dependencies.portwarpRunner.getSetupSnapshot(),
        system,
        serverDirectory: dependencies.pipeline.serverDirectoryPath,
        deployBusy: dependencies.pipeline.isRunning,
        scheduler: dependencies.scheduler.getSnapshot(),
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

  router.post('/playit/setup', requireSameOrigin, (_request, response) => {
    if (dependencies.tunnelProvider !== 'playit') {
      response.status(409).json({ error: 'Playit n’est pas le fournisseur de tunnel actif.' });
      return;
    }
    try {
      dependencies.playitRunner.requestSetup();
      response.status(202).json({ accepted: true, playitSetup: dependencies.playitRunner.getSetupSnapshot() });
    } catch (error) {
      response.status(409).json({
        error: (error as Error).message || 'Impossible de démarrer le setup Playit.',
        playitSetup: dependencies.playitRunner.getSetupSnapshot(),
      });
    }
  });

  router.post('/portwarp/retry', requireSameOrigin, (_request, response) => {
    if (dependencies.tunnelProvider !== 'portwarp') {
      response.status(409).json({ error: 'Portwarp n’est pas le fournisseur de tunnel actif.' });
      return;
    }
    try {
      dependencies.portwarpRunner.retry();
      response.status(202).json({ accepted: true, portwarpSetup: dependencies.portwarpRunner.getSetupSnapshot() });
    } catch (error) {
      response.status(409).json({
        error: (error as Error).message || 'Impossible de relancer Portwarp.',
        portwarpSetup: dependencies.portwarpRunner.getSetupSnapshot(),
      });
    }
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

  router.post('/start', requireSameOrigin, (request, response) => {
    try {
      dependencies.pipeline.startExisting();
      response.status(202).json({
        accepted: true,
        state: dependencies.state.getSnapshot(),
      });
    } catch (error) {
      if (error instanceof DeployInProgressError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof ServerNotInstalledError) {
        response.status(409).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la demande de démarrage.' });
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
