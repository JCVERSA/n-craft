import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import type { ViteDevServer } from 'vite';
import { createServer } from 'node:http';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { PanelAuthService } from './src/auth.ts';
import { BedrockConsole, attachConsoleWebSocket } from './src/bedrock/console.ts';
import { DeployPipeline } from './src/bedrock/deployPipeline.ts';
import { SystemInspector } from './src/preflight.ts';
import { PlayitRunner } from './src/playit/playitRunner.ts';
import { createAuthRouter } from './src/routes/auth.routes.ts';
import { createServerRouter } from './src/routes/server.routes.ts';
import { StateStore } from './src/state.ts';
import { VersionCatalog } from './src/versionCatalog.ts';
import { parseProxyTrust, requireHttpsInProduction } from './src/security.ts';

const projectDirectory = process.cwd();
const dataDirectory = path.resolve(projectDirectory, process.env.DATA_DIR?.trim() || 'data');
const serverDirectory = path.resolve(projectDirectory, process.env.BEDROCK_SERVER_DIR?.trim() || path.join('bedrock', 'server'));
const playitCommand = process.env.PLAYIT_BIN?.trim() || 'playitd';
const port = Number(process.env.PORT || 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT doit être un entier entre 1 et 65535.');
}

await mkdir(dataDirectory, { recursive: true });
const state = new StateStore(dataDirectory);
await state.initialize();
const catalog = new VersionCatalog(dataDirectory);
await catalog.load();

const auth = new PanelAuthService(process.env.PANEL_TOKEN);
const bedrockConsole = new BedrockConsole(dataDirectory);
const inspector = new SystemInspector(dataDirectory, serverDirectory, playitCommand);
const pipeline = new DeployPipeline(
  state,
  bedrockConsole,
  inspector,
  dataDirectory,
  serverDirectory,
  (version) => catalog.get(version),
);
const playitRunner = new PlayitRunner(playitCommand, process.env.PLAYIT_SECRET_KEY, state);

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
app.use('/api/auth', createAuthRouter(auth));
app.use('/api/server', createServerRouter({ auth, state, pipeline, bedrockConsole, inspector, catalog }));
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

bedrockConsole.on('exit', (event: { code: number | null; signal: NodeJS.Signals | null; wasReady: boolean; intentional?: boolean }) => {
  if (event.intentional) {
    void state.updateServer({ status: 'stopped', pid: null, startedAt: null, error: null }).catch((error) => {
      console.error(`[server] Could not persist Bedrock stop: ${(error as Error).message}`);
    });
    return;
  }
  if (event.wasReady) {
    const reason = event.signal ? `signal ${event.signal}` : `code ${event.code ?? 'inconnu'}`;
    const message = `bedrock_server s’est arrêté de façon inattendue (${reason}).`;
    void state.updateServer({ status: 'failed', pid: null, startedAt: null, error: message }).catch((error) => {
      console.error(`[server] Could not persist Bedrock failure: ${(error as Error).message}`);
    });
    void state.updatePipeline({ status: 'failed', step: 'running', error: message }).catch((error) => {
      console.error(`[server] Could not persist pipeline failure: ${(error as Error).message}`);
    });
  }
});

httpServer.listen(port, '0.0.0.0', () => {
  console.info(`[Nebula Craft] Panel listening on 0.0.0.0:${port}`);
  if (!auth.configured) console.warn('[Nebula Craft] PANEL_TOKEN absent : la connexion au panel est désactivée.');
  playitRunner.startOnce();
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
    consoleGateway.close().catch((error) => console.error(`[server] WebSocket close: ${(error as Error).message}`)),
    pipeline.shutdown().catch((error) => console.error(`[server] Bedrock shutdown: ${(error as Error).message}`)),
    playitRunner.shutdown().catch((error) => console.error(`[server] Playit shutdown: ${(error as Error).message}`)),
  ]);
  await viteServer?.close().catch((error) => console.error(`[server] Vite close: ${(error as Error).message}`));
  await serverClosed;
  await bedrockConsole.close();
  await state.flush();
  process.exitCode = 0;
};

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
