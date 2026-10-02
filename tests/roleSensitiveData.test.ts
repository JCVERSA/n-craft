import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';
import { PanelAuthService, type PanelPrincipal } from '../src/auth.ts';
import { createServerRouter, type ServerRouteDependencies } from '../src/routes/server.routes.ts';
import { createPixelStudioRouter } from '../src/routes/pixelStudio.routes.ts';
import type { PixelStudioAIService } from '../src/pixelStudio/aiService.ts';

const TOKEN = 'role-sensitive-data-test-panel-token-at-least-32-bytes';

function cookieFor(auth: PanelAuthService, principal: PanelPrincipal): string {
  let cookieHeader = '';
  const response = { setHeader(_name: string, value: string) { cookieHeader = value; } } as unknown as Response;
  auth.createSession(response, { headers: {}, secure: false } as unknown as Request, principal);
  return cookieHeader.split(';', 1)[0]!;
}

async function listen(app: express.Express, cleanup: (callback: () => Promise<void>) => void): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  cleanup(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('viewer status omits temporary integration credentials while operators can complete setup', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-sensitive-status-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new PanelAuthService(TOKEN, directory);
  await auth.initialize();
  await auth.createUser('viewer-test', 'viewer-test-password-long', 'viewer');
  await auth.createUser('operator-test', 'operator-test-password-long', 'operator');
  const viewer = (await auth.authenticate({ username: 'viewer-test', password: 'viewer-test-password-long' }))!;
  const operator = (await auth.authenticate({ username: 'operator-test', password: 'operator-test-password-long' }))!;

  const dependencies = {
    auth,
    inspector: { async inspect() { return { deployReady: true }; } },
    snapshots: { async getSnapshotWithDisk() { return { snapshots: [], storageUsedBytes: 0, diskFreeBytes: 1_000_000 }; } },
    state: { getSnapshot() { return { server: { status: 'stopped' }, pipeline: { status: 'idle' }, activeConfig: null }; } },
    tunnelProvider: 'playit',
    playitRunner: { getSetupSnapshot() { return { phase: 'claim_pending', claimUrl: 'https://playit.gg/claim/secret-test-code', error: null }; } },
    portwarpRunner: { getSetupSnapshot() { return { phase: 'waiting_for_approval', verificationUrl: 'https://portwarp.example/device', userCode: 'TEST-CODE', error: null }; } },
    pipeline: { serverDirectoryPath: '/srv/bedrock', isRunning: false },
    scheduler: { getSnapshot() { return {}; } },
    chatbot: { getSnapshot() { return { status: 'awaiting_approval', userActionPending: true, deviceCode: { verificationUrl: 'https://microsoft.com/devicelogin', userCode: 'MS-TEST-CODE', expiresAt: new Date(Date.now() + 60_000).toISOString() } }; } },
    recovery: { getSnapshot() { return {}; } },
    monitoring: { getSnapshot() { return {}; } },
  } as unknown as ServerRouteDependencies;
  const app = express();
  app.use('/api/server', createServerRouter(dependencies));
  const origin = await listen(app, (cleanup) => context.after(cleanup));

  const getStatus = async (cookie: string) => {
    const response = await fetch(`${origin}/api/server/status`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.json() as Promise<Record<string, any>>;
  };
  const viewerStatus = await getStatus(cookieFor(auth, viewer));
  assert.equal(viewerStatus.playitSetup.claimUrl, null);
  assert.equal(viewerStatus.portwarpSetup.userCode, null);
  assert.equal(viewerStatus.portwarpSetup.verificationUrl, null);
  assert.equal(viewerStatus.chatbot.deviceCode, null);
  assert.equal(viewerStatus.portwarpSetup.phase, 'waiting_for_approval', 'non-sensitive setup state remains visible');

  const operatorStatus = await getStatus(cookieFor(auth, operator));
  assert.equal(operatorStatus.playitSetup.claimUrl, 'https://playit.gg/claim/secret-test-code');
  assert.equal(operatorStatus.portwarpSetup.userCode, 'TEST-CODE');
  assert.equal(operatorStatus.chatbot.deviceCode.userCode, 'MS-TEST-CODE');
});

test('Pixel Studio generation and animation require operator role, not merely a session', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-pixel-rbac-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new PanelAuthService(TOKEN, directory);
  await auth.initialize();
  await auth.createUser('viewer-test', 'viewer-test-password-long', 'viewer');
  await auth.createUser('operator-test', 'operator-test-password-long', 'operator');
  const viewer = (await auth.authenticate({ username: 'viewer-test', password: 'viewer-test-password-long' }))!;
  const operator = (await auth.authenticate({ username: 'operator-test', password: 'operator-test-password-long' }))!;
  const calls = { generate: 0, animate: 0 };
  const ai = {
    getStatus() { return { configured: true }; },
    async generateMatrix() { calls.generate += 1; return { result: [[0]], provider: 'gemini' }; },
    async generateAnimation() { calls.animate += 1; return { result: [[[0]]], provider: 'gemini' }; },
  } as unknown as PixelStudioAIService;
  const app = express();
  app.use(express.json());
  app.use('/api/pixel-studio', createPixelStudioRouter(auth, ai));
  const origin = await listen(app, (cleanup) => context.after(cleanup));

  const send = (cookie: string, endpoint: 'generate' | 'animate') => fetch(`${origin}/api/pixel-studio/${endpoint}`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'test prompt', animationType: 'idle', frameCount: 2, currentMatrix: [[0]] }),
  });
  const viewerCookie = cookieFor(auth, viewer);
  const operatorCookie = cookieFor(auth, operator);

  assert.equal((await send(viewerCookie, 'generate')).status, 403);
  assert.equal((await send(viewerCookie, 'animate')).status, 403);
  assert.deepEqual(calls, { generate: 0, animate: 0 }, 'viewer requests must not reach paid AI providers');
  assert.equal((await send(operatorCookie, 'generate')).status, 200);
  assert.equal((await send(operatorCookie, 'animate')).status, 200);
  assert.deepEqual(calls, { generate: 1, animate: 1 });
});
