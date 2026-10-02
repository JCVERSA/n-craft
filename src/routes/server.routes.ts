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
import type { BedrockChatbotManager } from '../bedrock/chatbot/manager.ts';
import type { BedrockSnapshotManager } from '../bedrock/snapshots.ts';
import { SnapshotManagerError } from '../bedrock/snapshots.ts';
import type { BedrockRecoveryManager } from '../bedrock/recovery.ts';
import type { PlayerRoster } from '../bedrock/playerRoster.ts';
import type { BedrockNetworkMonitor } from '../networkProbe.ts';
import type { MonitoringService } from '../monitoring.ts';
import type { AuditLog } from '../audit.ts';
import { redactDiagnosticText, sanitizedAlerts, sanitizedLogLines, sanitizedSamples, sanitizedSystemReport } from '../diagnostics.ts';
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
  if (dependencies.pipeline.isRunning || dependencies.worldManager.isBusy) return 'Attends la fin de l’opération Bedrock ou du snapshot avant de gérer les mondes.';
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
  chatbot: BedrockChatbotManager;
  snapshots: BedrockSnapshotManager;
  recovery: BedrockRecoveryManager;
  players: PlayerRoster;
  network: BedrockNetworkMonitor;
  monitoring: MonitoringService;
  audit: AuditLog;
  tunnelProvider: TunnelProvider;
}

export function createServerRouter(dependencies: ServerRouteDependencies): Router {
  const router = Router();
  const requireViewer = dependencies.auth.requireRole('viewer');
  const requireOperator = dependencies.auth.requireRole('operator');
  const requireAdmin = dependencies.auth.requireRole('admin');
  router.use(requireViewer);
  router.use((request, response, next) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return next();
    return requireOperator(request, response, next);
  });

  const audit = async (request: import('express').Request, action: string, detail = '') => {
    await dependencies.audit.record(dependencies.auth.getPrincipal(request), action, detail).catch(() => undefined);
  };

  router.get('/status', async (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      const [system, snapshots] = await Promise.all([
        dependencies.inspector.inspect(),
        dependencies.snapshots.getSnapshotWithDisk(),
      ]);
      const principal = dependencies.auth.getPrincipal(request);
      const canViewSetupCredentials = principal !== null && principal.role !== 'viewer';
      const playitSetup = dependencies.playitRunner.getSetupSnapshot();
      const portwarpSetup = dependencies.portwarpRunner.getSetupSnapshot();
      const chatbot = dependencies.chatbot.getSnapshot();
      response.json({
        state: dependencies.state.getSnapshot(),
        tunnelProvider: dependencies.tunnelProvider,
        playitSetup: canViewSetupCredentials ? playitSetup : { ...playitSetup, claimUrl: null },
        portwarpSetup: canViewSetupCredentials
          ? portwarpSetup
          : { ...portwarpSetup, verificationUrl: null, userCode: null },
        system,
        serverDirectory: dependencies.pipeline.serverDirectoryPath,
        deployBusy: dependencies.pipeline.isRunning,
        scheduler: dependencies.scheduler.getSnapshot(),
        chatbot: canViewSetupCredentials ? chatbot : { ...chatbot, deviceCode: null },
        snapshots,
        recovery: dependencies.recovery.getSnapshot(),
        monitoring: dependencies.monitoring.getSnapshot(1),
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

  router.get('/snapshots', async (_request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.json(await dependencies.snapshots.getSnapshotWithDisk());
    } catch (error) {
      next(error);
    }
  });

  router.put('/snapshots/settings', requireAdmin, requireSameOrigin, async (request, response) => {
    try {
      const snapshot = await dependencies.snapshots.updateSettings(request.body);
      await audit(request, 'snapshot-settings-updated', `Planification ${snapshot.settings.enabled ? 'activée' : 'désactivée'}; intervalle ${snapshot.settings.intervalHours} h, rétention ${snapshot.settings.retentionPerWorld}.`);
      response.json(snapshot);
    } catch (error) {
      if (error instanceof SnapshotManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(400).json({ error: (error as Error).message || 'Réglages de snapshots invalides.' });
    }
  });

  router.get('/worlds/:id/snapshots', (request, response) => {
    try {
      const world = dependencies.worldManager.getWorld(request.params.id);
      response.setHeader('Cache-Control', 'no-store');
      response.json({ worldId: world.id, snapshots: dependencies.snapshots.listForWorld(world.id) });
    } catch (error) {
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: 'Impossible de lister les snapshots du monde.' });
    }
  });

  router.post('/worlds/:id/snapshots', requireSameOrigin, async (request, response) => {
    try {
      const world = dependencies.worldManager.getWorld(request.params.id);
      const snapshot = await dependencies.snapshots.createSnapshot(world.id, 'manual');
      await audit(request, 'world-snapshot-created', `Snapshot manuel créé pour ${world.name} (${snapshot.sizeBytes} octets).`);
      response.status(201).json({ snapshot, manager: await dependencies.snapshots.getSnapshotWithDisk() });
    } catch (error) {
      if (error instanceof SnapshotManagerError || error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la création du snapshot.' });
    }
  });

  router.get('/snapshots/:id/download', async (request, response) => {
    try {
      const archive = await dependencies.snapshots.getArchive(request.params.id);
      response.setHeader('Content-Type', 'application/zip');
      response.attachment(archive.fileName);
      await streamPipeline(archive.stream, response);
    } catch (error) {
      if (error instanceof SnapshotManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (!response.headersSent) response.status(500).json({ error: 'Échec du téléchargement du snapshot.' });
      else response.destroy(error as Error);
    }
  });

  router.post('/snapshots/:id/restore', requireAdmin, requireSameOrigin, async (request, response) => {
    try {
      const result = await dependencies.snapshots.restoreSnapshot(request.params.id);
      await audit(request, 'world-snapshot-restored', `Snapshot ${result.restored.id} restauré; sauvegarde préalable ${result.beforeRestore?.id ?? 'non nécessaire (monde absent)'}.`);
      response.json({ ...result, manager: await dependencies.snapshots.getSnapshotWithDisk() });
    } catch (error) {
      if (error instanceof SnapshotManagerError || error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la restauration du snapshot.' });
    }
  });

  router.delete('/snapshots/:id', requireAdmin, requireSameOrigin, async (request, response) => {
    try {
      await dependencies.snapshots.deleteSnapshot(request.params.id);
      await audit(request, 'world-snapshot-deleted', `Snapshot ${request.params.id} supprimé.`);
      response.json({ deleted: true, id: request.params.id });
    } catch (error) {
      if (error instanceof SnapshotManagerError || error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: 'Échec de la suppression du snapshot.' });
    }
  });

  router.get('/players', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      players: dependencies.players.list(),
      admins: dependencies.state.getSnapshot().activeConfig?.adminXuids ?? [],
    });
  });

  router.put('/access/admins', requireAdmin, requireSameOrigin, async (request, response) => {
    try {
      const current = dependencies.state.getSnapshot().activeConfig;
      if (!current) throw new ServerNotInstalledError();
      const entries = request.body?.adminXuids;
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 3
        || entries.some((entry: unknown) => typeof entry !== 'string' || !/^\d{1,20}$/.test(entry))) {
        response.status(400).json({ error: 'Fournis de 1 à 3 XUID administrateur contenant uniquement des chiffres.' });
        return;
      }
      const adminXuids = entries as string[];
      if (new Set(adminXuids).size !== adminXuids.length) {
        response.status(400).json({ error: 'Les XUID administrateur doivent être uniques.' });
        return;
      }
      const next = { ...current, adminXuids: [...adminXuids] };
      await dependencies.pipeline.saveConfiguration(next);
      const activeWorld = dependencies.worldManager.findByVersionAndFolder(current.version, current.levelName);
      if (activeWorld) await dependencies.worldManager.updateConfiguration(activeWorld.id, next);
      await audit(request, 'bedrock-admins-updated', `${adminXuids.length} XUID administrateur enregistrés dans permissions.json.`);
      response.json({ admins: adminXuids, state: dependencies.state.getSnapshot() });
    } catch (error) {
      if (error instanceof DeployInProgressError || error instanceof ServerNotInstalledError || error instanceof ServerRunningError) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof WorldManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la mise à jour des administrateurs Bedrock.' });
    }
  });

  router.get('/audit', dependencies.auth.requireRole('admin'), (request, response) => {
    const limit = Number(request.query.limit ?? 100);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ events: dependencies.audit.list(Number.isFinite(limit) ? limit : 100) });
  });

  router.get('/recovery', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(dependencies.recovery.getSnapshot());
  });

  router.put('/recovery/settings', requireAdmin, requireSameOrigin, async (request, response) => {
    try {
      const recovery = await dependencies.recovery.updateSettings(request.body);
      await audit(request, 'recovery-settings-updated', `Reprise crash ${recovery.settings.restartAfterCrash ? 'activée' : 'désactivée'}; démarrage après restart ${recovery.settings.startAfterPanelRestart ? 'activé' : 'désactivé'}.`);
      response.json(recovery);
    } catch (error) {
      response.status(400).json({ error: (error as Error).message || 'Réglages de reprise invalides.' });
    }
  });

  router.get('/monitoring', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(dependencies.monitoring.getSnapshot());
  });

  router.put('/monitoring/settings', requireAdmin, requireSameOrigin, async (request, response) => {
    try {
      const monitoring = await dependencies.monitoring.updateSettings(request.body);
      await audit(request, 'monitoring-settings-updated', 'Seuils d’alertes métriques mis à jour.');
      response.json(monitoring);
    } catch (error) {
      response.status(400).json({ error: (error as Error).message || 'Réglages de supervision invalides.' });
    }
  });

  router.get('/network-check', async (request, response) => {
    const source = request.query.source;
    if (source !== 'local' && source !== 'tunnel') {
      response.status(400).json({ error: 'Choisis source=local ou source=tunnel.' });
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.json(await dependencies.network.probe(source));
  });

  router.get('/diagnostics/export', async (_request, response, next) => {
    try {
      const [system, snapshots] = await Promise.all([
        dependencies.inspector.inspect(true),
        dependencies.snapshots.getSnapshotWithDisk(),
      ]);
      const state = dependencies.state.getSnapshot();
      const monitoring = dependencies.monitoring.getSnapshot(240);
      const recoverySnapshot = dependencies.recovery.getSnapshot();
      const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        privacy: {
          secretsIncluded: false,
          environmentVariablesIncluded: false,
          worldContentsIncluded: false,
          panelPasswordsIncluded: false,
          playerIdentitiesIncluded: false,
          notes: 'Jetons, cookies, secrets d’intégration, seeds, noms/XUID de joueurs, adresses de tunnel et commandes console sont exclus ou expurgés.',
        },
        runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
        server: {
          status: state.server.status,
          desiredRunning: state.server.desiredRunning,
          playersOnline: state.server.playersOnline,
          cpuPercent: state.server.cpuPercent,
          memoryBytes: state.server.memoryBytes,
          pipelineStatus: state.pipeline.status,
          pipelineStep: state.pipeline.step,
          pipelineError: state.pipeline.error ? redactDiagnosticText(state.pipeline.error) : null,
          serverError: state.server.error ? redactDiagnosticText(state.server.error) : null,
          activeBuild: state.activeConfig?.version ?? null,
          tunnelProvider: dependencies.tunnelProvider,
          tunnelLifecycle: dependencies.tunnelProvider === 'portwarp' ? state.portwarp.status
            : dependencies.tunnelProvider === 'playit' ? state.playit.status : state.localtonet.status,
          publicTunnelAddressPresent: Boolean(dependencies.tunnelProvider === 'portwarp' ? state.portwarp.address
            : dependencies.tunnelProvider === 'playit' ? state.playit.address : state.localtonet.address),
        },
        system: sanitizedSystemReport(system),
        recovery: {
          ...recoverySnapshot,
          lastError: recoverySnapshot.lastError ? redactDiagnosticText(recoverySnapshot.lastError) : null,
        },
        snapshots: {
          settings: {
            ...snapshots.settings,
            lastError: snapshots.settings.lastError ? redactDiagnosticText(snapshots.settings.lastError) : null,
          },
          count: snapshots.snapshots.length,
          storageUsedBytes: snapshots.storageUsedBytes,
          diskFreeBytes: snapshots.diskFreeBytes,
          diskWarning: snapshots.diskWarning,
        },
        monitoring: { settings: monitoring.settings, alerts: sanitizedAlerts(monitoring.alerts), samples: sanitizedSamples(monitoring.samples) },
        recentLogs: sanitizedLogLines(dependencies.bedrockConsole.getRecentLines()),
      };
      const filename = `ncraft-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.attachment(filename);
      response.send(`${JSON.stringify(report, null, 2)}\n`);
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
      if (selection.mode === 'existing') {
        await dependencies.snapshots.createSnapshot(resolved.worldId, 'before-deploy');
      }
      await dependencies.recovery.prepareManualStart();
      if (currentConfig?.version === resolved.configuration.version) {
        dependencies.pipeline.startExisting(resolved.configuration);
      } else {
        dependencies.pipeline.start(resolved.configuration);
      }
      await audit(request, 'bedrock-deploy-started', `Déploiement ${resolved.configuration.version}; monde ${resolved.worldId}.`);
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
      if (error instanceof WorldManagerError || error instanceof SnapshotManagerError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: (error as Error).message || 'Échec de la demande de déploiement.' });
    }
  });

  router.post('/chatbot/link', requireSameOrigin, async (request, response) => {
    if (request.body?.confirm !== 'I_CONFIRM_MICROSOFT_DEVICE_AUTH') {
      response.status(400).json({ error: 'Confirme explicitement le démarrage du flux Microsoft depuis Diagnostics.' });
      return;
    }
    try {
      await dependencies.chatbot.startUserApprovedLink();
      response.status(202).json({ accepted: true, chatbot: dependencies.chatbot.getSnapshot() });
    } catch (error) {
      response.status(409).json({ error: (error as Error).message || 'Impossible de démarrer le chatbot.' });
    }
  });

  router.post('/chatbot/cancel', requireSameOrigin, async (_request, response) => {
    try {
      await dependencies.chatbot.cancelUserApprovedLink();
      response.json({ cancelled: true, chatbot: dependencies.chatbot.getSnapshot() });
    } catch {
      response.status(500).json({ error: 'Impossible d’annuler le flux du chatbot.' });
    }
  });

  router.delete('/chatbot/account', requireSameOrigin, async (request, response) => {
    if (request.body?.confirm !== 'UNLINK_BEDROCK_CHATBOT_ACCOUNT') {
      response.status(400).json({ error: 'Confirme explicitement la suppression du profil dédié.' });
      return;
    }
    try {
      await dependencies.chatbot.unlinkAccount();
      response.json({ unlinked: true, chatbot: dependencies.chatbot.getSnapshot() });
    } catch {
      response.status(500).json({ error: 'Impossible de supprimer le profil privé du chatbot.' });
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
      await dependencies.recovery.prepareManualStart();
      dependencies.pipeline.startExisting();
      await audit(_request, 'bedrock-start-requested', 'Démarrage manuel demandé.');
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

  router.post('/stop', requireSameOrigin, async (request, response) => {
    try {
      await dependencies.recovery.prepareManualStop();
      await dependencies.pipeline.stop();
      await audit(request, 'bedrock-stop-requested', 'Arrêt manuel demandé; reprise automatique désactivée pour cet arrêt.');
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
