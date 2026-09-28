import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Router } from 'express';
import type { PanelAuthService } from '../auth.ts';
import { DeployInProgressError, DeployPipeline, ServerNotInstalledError, ServerRunningError } from '../bedrock/deployPipeline.ts';
import { ConfigurationError, validateDeployConfiguration } from '../bedrock/configWriter.ts';
import { BedrockConsole } from '../bedrock/console.ts';
import type { BedrockRestartScheduler } from '../bedrock/scheduler.ts';
import type { StateStore } from '../state.ts';
import { requireSameOrigin } from '../security.ts';
import { SystemInspector } from '../preflight.ts';
import { VersionCatalog } from '../versionCatalog.ts';
import { getMaxArchiveBytes } from '../bedrock/limits.ts';
import { normalizeWorldName, WorldManager, WorldManagerError } from '../bedrock/worldManager.ts';
import type { PlayitRunner } from '../playit/playitRunner.ts';
import type { PortwarpRunner } from '../portwarp/portwarpRunner.ts';
import type { TunnelProvider, WorldSelection } from '../types/backend.ts';

function parseWorldSelection(value: unknown, fallbackName: string): WorldSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { mode: 'new', name: normalizeWorldName(fallbackName) };
  }
  const raw = value as Record<string, unknown>;
  if (raw.mode === 'existing' && typeof raw.id === 'string') return { mode: 'existing', id: raw.id };
  if (raw.mode === 'new') return { mode: 'new', name: normalizeWorldName(raw.name) };
  throw new WorldManagerError('Choix de monde invalide.');
}

function stoppedForWorldMutation(dependencies: ServerRouteDependencies): string | null {
  const status = dependencies.state.getSnapshot().server;
  if (dependencies.bedrockConsole.isRunning || status.status === 'running' || (status.status === 'failed' && status.pid !== null)) return 'Arrête Bedrock avant de modifier, importer ou supprimer un monde.';
  if (dependencies.pipeline.isRunning) return 'Attends la fin de l’opération Bedrock avant de gérer les mondes.';
  return null;
}

export interface ServerRouteDependencies {
  auth: PanelAuthService;
  state: StateStore;
  pipeline: DeployPipeline;
  bedrockConsole: BedrockConsole;
  scheduler: BedrockRestartScheduler;
  inspector: SystemInspector;
  catalog: VersionCatalog;
  worldManager: WorldManager;
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

  router.get('/worlds', async (_request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.json({ worlds: await dependencies.worldManager.listWorlds() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/worlds/:id/export', async (request, response) => {
    const serverSnapshot = dependencies.state.getSnapshot().server;
    if (dependencies.bedrockConsole.isRunning || serverSnapshot.status === 'running' || (serverSnapshot.status === 'failed' && serverSnapshot.pid !== null) || dependencies.pipeline.isRunning) {
      response.status(409).json({ error: 'Arrête Bedrock et attends la fin des opérations pour garantir une archive cohérente.' });
      return;
    }
    try {
      const archive = await dependencies.worldManager.createWorldArchive(request.params.id);
      response.setHeader('Content-Type', 'application/zip');
      response.attachment(archive.fileName);
      await streamPipeline(archive.stream, response);
    } catch (error) {
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (!response.headersSent) response.status(500).json({ error: (error as Error).message || 'Échec de l’export du monde.' });
      else response.destroy(error as Error);
    }
  });

  router.post('/worlds/import', requireSameOrigin, async (request, response) => {
    const unavailable = stoppedForWorldMutation(dependencies);
    if (unavailable) {
      response.status(409).json({ error: unavailable });
      return;
    }
    const version = (request.header('x-world-version') ?? (typeof request.query.version === 'string' ? request.query.version : '')).trim();
    const rawFileName = (request.header('x-world-file-name') ?? (typeof request.query.fileName === 'string' ? request.query.fileName : '')).trim();
    const name = (request.header('x-world-name') ?? (typeof request.query.name === 'string' ? request.query.name : '')).trim();
    if (!dependencies.catalog.get(version)) {
      response.status(400).json({ error: 'Choisis une version BDS du catalogue pour importer ce monde.' });
      return;
    }
    if (!/\.(mcworld|zip)$/i.test(rawFileName)) {
      response.status(400).json({ error: 'Sélectionne une archive .mcworld ou .zip Bedrock.' });
      return;
    }
    const declaredLength = Number(request.header('content-length') ?? 0);
    const maxBytes = getMaxArchiveBytes();
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.status(413).json({ error: 'Archive trop volumineuse.' });
      return;
    }

    const uploadPath = path.join(path.dirname(dependencies.worldManager.manifestPath), `.world-upload-${randomUUID()}.zip`);
    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) callback(new WorldManagerError('Archive trop volumineuse.', 413));
        else callback(null, chunk);
      },
    });

    try {
      await streamPipeline(request, limiter, createWriteStream(uploadPath, { flags: 'wx', mode: 0o600 }));
      const unavailableAfterUpload = stoppedForWorldMutation(dependencies);
      if (unavailableAfterUpload) {
        response.status(409).json({ error: unavailableAfterUpload });
        return;
      }
      if (receivedBytes === 0) throw new WorldManagerError('Le fichier importé est vide.');
      const imported = await dependencies.worldManager.importArchive(
        uploadPath,
        normalizeWorldName(name || path.basename(rawFileName, path.extname(rawFileName))),
        version,
        dependencies.state.getSnapshot().activeConfig,
      );
      response.status(201).json({ world: imported });
    } catch (error) {
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(400).json({ error: (error as Error).message || 'Archive de monde invalide.' });
    } finally {
      await rm(uploadPath, { force: true }).catch(() => undefined);
    }
  });

  router.patch('/worlds/:id', requireSameOrigin, async (request, response) => {
    const unavailable = stoppedForWorldMutation(dependencies);
    if (unavailable) {
      response.status(409).json({ error: unavailable });
      return;
    }
    try {
      let world;
      if (request.body?.configuration !== undefined) {
        const record = dependencies.worldManager.getWorld(request.params.id);
        if (!record.version) throw new WorldManagerError('Associe d’abord ce monde à une version BDS avant de modifier ses options.', 409);
        const allowedVersions = new Set(dependencies.catalog.allowedVersionIds());
        allowedVersions.add(record.version);
        const config = validateDeployConfiguration(request.body.configuration, allowedVersions);
        if (config.version !== record.version) throw new WorldManagerError('La version d’un monde existant est immuable.', 409);
        if (config.levelName !== record.folder) throw new WorldManagerError('Le dossier d’un monde existant ne peut pas être renommé depuis les propriétés.', 409);
        if (dependencies.state.getSnapshot().activeConfig?.version === record.version
          && dependencies.state.getSnapshot().activeConfig?.levelName === record.folder) {
          await dependencies.pipeline.saveConfiguration(config);
        }
        await dependencies.worldManager.updateConfiguration(record.id, config);
        world = (await dependencies.worldManager.listWorlds()).find((candidate) => candidate.id === record.id);
      } else {
        world = await dependencies.worldManager.renameWorld(request.params.id, request.body?.name);
      }
      response.json({ world });
    } catch (error) {
      if (error instanceof DeployInProgressError || error instanceof ServerNotInstalledError || error instanceof ServerRunningError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof ConfigurationError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la modification du monde.' });
    }
  });

  router.post('/worlds/:id/assign', requireSameOrigin, async (request, response) => {
    const unavailable = stoppedForWorldMutation(dependencies);
    if (unavailable) {
      response.status(409).json({ error: unavailable });
      return;
    }
    try {
      const version = typeof request.body?.version === 'string' ? request.body.version : '';
      if (!dependencies.catalog.get(version)) throw new WorldManagerError('Cette version BDS ne figure pas dans le catalogue.');
      const world = await dependencies.worldManager.assignVersion(request.params.id, version);
      response.json({ world });
    } catch (error) {
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de l’association du monde à sa version.' });
    }
  });

  router.delete('/worlds/:id', requireSameOrigin, async (request, response) => {
    const unavailable = stoppedForWorldMutation(dependencies);
    if (unavailable) {
      response.status(409).json({ error: unavailable });
      return;
    }
    try {
      const record = dependencies.worldManager.getWorld(request.params.id);
      const deleted = await dependencies.worldManager.deleteWorld(request.params.id, request.body?.confirmName);
      const activeConfig = dependencies.state.getSnapshot().activeConfig;
      if (activeConfig?.version === record.version && activeConfig.levelName === record.folder) {
        await dependencies.state.setActiveConfig(null);
      }
      response.json({ deleted: true, id: deleted.id });
    } catch (error) {
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la suppression du monde.' });
    }
  });

  router.get('/logs', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ lines: dependencies.bedrockConsole.getRecentLines() });
  });

  router.post('/configuration', requireSameOrigin, async (request, response) => {
    try {
      const currentConfig = dependencies.state.getSnapshot().activeConfig;
      const allowedVersions = new Set(dependencies.catalog.allowedVersionIds());
      if (currentConfig?.version) allowedVersions.add(currentConfig.version);
      const config = validateDeployConfiguration(request.body?.config, allowedVersions);
      const activeWorld = currentConfig
        ? dependencies.worldManager.findByVersionAndFolder(currentConfig.version, currentConfig.levelName)
        : null;
      if (activeWorld) {
        if (config.seed !== (activeWorld.seed ?? '')) {
          throw new WorldManagerError('La seed d’un monde existant est verrouillée. Crée un nouveau monde pour générer une autre seed.', 409);
        }
        config.levelName = activeWorld.folder;
        config.seed = activeWorld.seed ?? '';
      }
      await dependencies.pipeline.saveConfiguration(config);
      if (activeWorld) await dependencies.worldManager.updateConfiguration(activeWorld.id, config);
      response.json({ saved: true, state: dependencies.state.getSnapshot() });
    } catch (error) {
      if (error instanceof DeployInProgressError || error instanceof ServerNotInstalledError || error instanceof ServerRunningError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof ConfigurationError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de l’enregistrement des réglages.' });
    }
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

  router.post('/deploy', requireSameOrigin, async (request, response) => {
    try {
      const server = dependencies.state.getSnapshot().server;
      if (dependencies.bedrockConsole.isRunning || server.status === 'running') {
        response.status(409).json({ error: 'Arrête Bedrock avant de modifier la configuration ou la version.' });
        return;
      }
      const config = validateDeployConfiguration(request.body?.config, dependencies.catalog.allowedVersionIds());
      const selection = parseWorldSelection(request.body?.world, config.levelName);
      const resolved = await dependencies.worldManager.resolveForDeployment(config, selection);
      const currentConfig = dependencies.state.getSnapshot().activeConfig;
      if (currentConfig?.version === resolved.configuration.version) {
        dependencies.pipeline.startExisting(resolved.configuration);
      } else {
        dependencies.pipeline.start(resolved.configuration);
      }
      response.status(202).json({
        accepted: true,
        worldId: resolved.worldId,
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
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la demande de déploiement.' });
    }
  });

  router.post('/start', requireSameOrigin, async (_request, response) => {
    try {
      if (dependencies.bedrockConsole.isRunning || dependencies.state.getSnapshot().server.status === 'running') {
        response.status(409).json({ error: 'Bedrock est déjà en ligne.' });
        return;
      }
      const activeConfig = dependencies.state.getSnapshot().activeConfig;
      if (activeConfig) await dependencies.worldManager.ensureActiveWorld(activeConfig);
      dependencies.pipeline.startExisting();
      response.status(202).json({
        accepted: true,
        state: dependencies.state.getSnapshot(),
      });
    } catch (error) {
      if (error instanceof DeployInProgressError || error instanceof ServerNotInstalledError || error instanceof WorldManagerError) {
        response.status(error instanceof WorldManagerError ? error.statusCode : 409).json({ error: error.message });
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
