import dotenv from 'dotenv';
import express, { type ErrorRequestHandler } from 'express';
import type { ViteDevServer } from 'vite';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { PanelAuthService } from './src/auth.ts';
import { AuditLog } from './src/audit.ts';
import { buildChildEnvironment } from './src/childEnvironment.ts';
import { BedrockConsole, attachConsoleWebSocket } from './src/bedrock/console.ts';
import { BedrockChatbotManager } from './src/bedrock/chatbot/manager.ts';
import { DeployPipeline } from './src/bedrock/deployPipeline.ts';
import { WorldManager } from './src/bedrock/worldManager.ts';
import { BedrockRestartScheduler } from './src/bedrock/scheduler.ts';
import { BedrockMetricsSampler } from './src/bedrock/processMetrics.ts';
import { BedrockSnapshotManager } from './src/bedrock/snapshots.ts';
import { BedrockRecoveryManager } from './src/bedrock/recovery.ts';
import { PlayerRoster } from './src/bedrock/playerRoster.ts';
import { BedrockNetworkMonitor } from './src/networkProbe.ts';
import { MonitoringService } from './src/monitoring.ts';
import { SystemInspector } from './src/preflight.ts';
import { PlayitRunner } from './src/playit/playitRunner.ts';
import { LocaltonetRunner } from './src/localtonet/localtonetRunner.ts';
import { PortwarpRunner } from './src/portwarp/portwarpRunner.ts';
import { resolveTunnelProvider } from './src/tunnelProvider.ts';
import { createAuthRouter } from './src/routes/auth.routes.ts';
import { createPixelStudioRouter } from './src/routes/pixelStudio.routes.ts';
import { createServerRouter } from './src/routes/server.routes.ts';
import { PixelStudioAIService } from './src/pixelStudio/aiService.ts';
import { StateStore } from './src/state.ts';
import { VersionCatalog } from './src/versionCatalog.ts';
import { parseProxyTrust, requireHttpsInProduction } from './src/security.ts';

const externallyConfiguredTunnelProvider = process.env.TUNNEL_PROVIDER?.trim();
dotenv.config();
const projectDirectory = process.cwd();
if (!externallyConfiguredTunnelProvider && process.env.TUNNEL_PROVIDER?.trim().toLowerCase() === 'localtonet') {
  // One-time migration of the old default only. A later explicit Localtonet
  // choice is preserved by the migration marker in .env.
  const migration = spawnSync(
    process.execPath,
    [path.join(projectDirectory, 'scripts', 'env-manager.mjs'), 'migrate-tunnel-provider-default'],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 32 * 1024, env: buildChildEnvironment() },
  );
  if (migration.status === 0) {
    process.env.TUNNEL_PROVIDER = migration.stdout.trim() || 'portwarp';
  } else {
    console.warn('[config] Could not migrate the old Localtonet default; Portwarp will be used for this panel start.');
    process.env.TUNNEL_PROVIDER = 'portwarp';
  }
}
const dataDirectory = path.resolve(projectDirectory, process.env.DATA_DIR?.trim() || 'data');
const serverDirectory = path.resolve(projectDirectory, process.env.BEDROCK_SERVER_DIR?.trim() || path.join('bedrock', 'server'));
const playitCommand = process.env.PLAYIT_BIN?.trim() || 'playitd';
const portwarpCommand = process.env.PORTWARP_BIN?.trim() || 'pwrp';
const tunnelProvider = resolveTunnelProvider();
const port = Number(process.env.PORT || 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT doit être un entier entre 1 et 65535.');
}

await mkdir(dataDirectory, { recursive: true });
const state = new StateStore(dataDirectory);
await state.initialize();
const catalog = new VersionCatalog(dataDirectory);
await catalog.load();
const worldManager = new WorldManager(dataDirectory, serverDirectory);

const pixelStudioAI = new PixelStudioAIService();
const bedrockConsole = new BedrockConsole(dataDirectory);
const inspector = new SystemInspector(
  dataDirectory,
  serverDirectory,
  playitCommand,
  process.env.PLAYIT_CLI_BIN || 'playit',
  process.env.LOCALTONET_BIN || 'localtonet',
  tunnelProvider,
  portwarpCommand,
);
const pipeline = new DeployPipeline(
  state,
  bedrockConsole,
  inspector,
  dataDirectory,
  serverDirectory,
  (version) => catalog.get(version),
  undefined,
  worldManager,
);
await worldManager.initialize(state.getSnapshot().activeConfig);
const auth = new PanelAuthService(process.env.PANEL_TOKEN, dataDirectory);
await auth.initialize();
const audit = new AuditLog(dataDirectory);
await audit.initialize();
const scheduler = new BedrockRestartScheduler(state, bedrockConsole, pipeline);
const metricsSampler = new BedrockMetricsSampler(state);
const snapshots = new BedrockSnapshotManager(dataDirectory, worldManager, bedrockConsole, state);
await snapshots.initialize();
const recovery = new BedrockRecoveryManager(dataDirectory, state, bedrockConsole, pipeline);
await recovery.initialize();
const players = new PlayerRoster(dataDirectory, bedrockConsole);
await players.initialize();
const monitoring = new MonitoringService(dataDirectory, state, inspector);
await monitoring.initialize();
const network = new BedrockNetworkMonitor(state, bedrockConsole, tunnelProvider);
const playitRunner = new PlayitRunner(playitCommand, process.env.PLAYIT_SECRET_KEY, state, {
  cliCommand: process.env.PLAYIT_CLI_BIN || 'playit',
  dataDirectory,
});
const localtonetRunner = new LocaltonetRunner(state, { dataDirectory });
const portwarpRunner = new PortwarpRunner(state, { binaryCommand: portwarpCommand });
const chatbot = new BedrockChatbotManager({
  dataDirectory,
  serverDirectory,
  bedrockConsole,
  state,
  findVersion: (version) => catalog.get(version),
});
await chatbot.initialize();
state.on('change', (snapshot) => {
  void chatbot.syncState(snapshot).catch(() => undefined);
});
void chatbot.syncState(state.getSnapshot()).catch(() => undefined);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', parseProxyTrust());
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (request.secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '16kb', strict: true }));

app.get('/api/health', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({ ok: true, panelTokenConfigured: auth.configured });
});
// Keep the non-sensitive health probe available to the container supervisor;
// all interactive UI and authentication routes require a trusted HTTPS hop in production.
app.use(requireHttpsInProduction);
app.use('/api/auth', createAuthRouter(auth, audit));
app.use('/api/pixel-studio', createPixelStudioRouter(auth, pixelStudioAI));
app.use('/api/server', createServerRouter({
  auth,
  state,
  pipeline,
  bedrockConsole,
  scheduler,
  inspector,
  catalog,
  worldManager,
  playitRunner,
  portwarpRunner,
  chatbot,
  snapshots,
  recovery,
  players,
  network,
  monitoring,
  audit,
  tunnelProvider,
}));
app.use('/api', (_request, response) => response.status(404).json({ error: 'Route API introuvable.' }));

let viteServer: ViteDevServer | null = null;
if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite');
  viteServer = await createViteServer({
    configFile: path.resolve(projectDirectory, 'vite.config.ts'),
    server: {
      middlewareMode: true,
      host: '0.0.0.0',
      allowedHosts: true,
      hmr: false,
    },
    appType: 'spa',
  });
  app.use(viteServer.middlewares);
} else {
  const staticDirectory = path.resolve(projectDirectory, 'dist');
  app.use(express.static(staticDirectory, { index: false, fallthrough: true }));
  app.get('*', async (_request, response) => {
    try {
      await access(path.join(staticDirectory, 'index.html'));
      response.sendFile(path.join(staticDirectory, 'index.html'));
    } catch {
      response.status(503).type('text/plain').send('Nebula Craft UI is not built. Run npm run build first.');
    }
  });
}

const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (request.path.startsWith('/api/')) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    response.status(status).json({ error: status === 400 ? 'Corps JSON invalide.' : 'Erreur serveur.' });
    return;
  }
  response.status(500).type('text/plain').send('Erreur serveur.');
};
app.use(errorHandler);

const httpServer = createServer(app);
const consoleGateway = attachConsoleWebSocket(httpServer, auth, bedrockConsole, state);

bedrockConsole.on('players', (playersOnline: number) => {
  if (state.getSnapshot().server.playersOnline === playersOnline) return;
  void state.updateServer({ playersOnline }).catch((error) => {
    console.error(`[server] Could not persist online player count: ${(error as Error).message}`);
  });
});

bedrockConsole.on('exit', (event: { code: number | null; signal: NodeJS.Signals | null; wasReady: boolean; intentional?: boolean }) => {
  void chatbot.onBedrockExit().catch(() => undefined);
  void players.markAllOffline().catch((error) => console.warn(`[players] Could not mark the roster offline: ${(error as Error).message}`));
  if (event.intentional) {
    void state.updateServer({
      status: 'stopped', pid: null, startedAt: null, error: null,
      playersOnline: 0, cpuPercent: null, memoryBytes: null, metricsUpdatedAt: null,
    }).catch((error) => {
      console.error(`[server] Could not persist Bedrock stop: ${(error as Error).message}`);
    });
    return;
  }
  if (event.wasReady) {
    const reason = event.signal ? `signal ${event.signal}` : `code ${event.code ?? 'inconnu'}`;
    const message = `bedrock_server s’est arrêté de façon inattendue (${reason}).`;
    void state.updateServer({
      status: 'failed', pid: null, startedAt: null, error: message,
      playersOnline: 0, cpuPercent: null, memoryBytes: null, metricsUpdatedAt: null,
    }).catch((error) => {
      console.error(`[server] Could not persist Bedrock failure: ${(error as Error).message}`);
    });
    void state.updatePipeline({ status: 'failed', step: 'running', error: message }).catch((error) => {
      console.error(`[server] Could not persist pipeline failure: ${(error as Error).message}`);
    });
  }
});

httpServer.listen(port, '0.0.0.0', () => {
  console.info(`[Nebula Craft] Panel listening on 0.0.0.0:${port}`);
  metricsSampler.start();
  monitoring.start();
  snapshots.start();
  scheduler.start();
  recovery.start();
  if (!auth.configured) console.warn('[Nebula Craft] PANEL_TOKEN absent : la connexion au panel est désactivée.');
  if (tunnelProvider === 'portwarp') {
    portwarpRunner.startOnce();
  } else if (tunnelProvider === 'localtonet') {
    localtonetRunner.startOnce();
  } else {
    playitRunner.startOnce();
  }
});

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[Nebula Craft] ${signal} received; stopping child processes.`);
  const serverClosed = new Promise<void>((resolve) => {
    if (!httpServer.listening) return resolve();
    httpServer.close(() => resolve());
  });
  await Promise.all([
    chatbot.shutdown().catch(() => undefined),
    consoleGateway.close().catch((error) => console.error(`[server] WebSocket close: ${(error as Error).message}`)),
    scheduler.shutdown().catch((error) => console.error(`[server] Scheduler shutdown: ${(error as Error).message}`)),
    recovery.shutdown().catch((error) => console.error(`[server] Recovery shutdown: ${(error as Error).message}`)),
    snapshots.shutdown().catch((error) => console.error(`[server] Snapshots shutdown: ${(error as Error).message}`)),
    monitoring.shutdown().catch((error) => console.error(`[server] Monitoring shutdown: ${(error as Error).message}`)),
    players.shutdown().catch((error) => console.error(`[server] Player roster shutdown: ${(error as Error).message}`)),
    metricsSampler.shutdown().catch((error) => console.error(`[server] Metrics shutdown: ${(error as Error).message}`)),
    playitRunner.shutdown().catch((error) => console.error(`[server] Playit shutdown: ${(error as Error).message}`)),
    localtonetRunner.shutdown().catch((error) => console.error(`[server] Localtonet shutdown: ${(error as Error).message}`)),
    portwarpRunner.shutdown().catch((error) => console.error(`[server] Portwarp shutdown: ${(error as Error).message}`)),
  ]);
  await pipeline.shutdown().catch((error) => console.error(`[server] Bedrock shutdown: ${(error as Error).message}`));
  await viteServer?.close().catch((error) => console.error(`[server] Vite close: ${(error as Error).message}`));
  await serverClosed;
  await audit.flush().catch((error) => console.error(`[server] Audit flush: ${(error as Error).message}`));
  await bedrockConsole.close();
  await state.flush();
  process.exitCode = 0;
};

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
