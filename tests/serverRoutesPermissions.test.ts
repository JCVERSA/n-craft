import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServerRouter, type ServerRouteDependencies } from '../src/routes/server.routes.ts';
import { PanelAuthService, type PanelPrincipal } from '../src/auth.ts';
import type { RecoverySnapshot } from '../src/types/backend.ts';
import type { Request, Response } from 'express';
import test from 'node:test';

const TOKEN = 'route-test-panel-token-with-at-least-thirty-two-bytes';

function cookieFor(auth: PanelAuthService, principal: PanelPrincipal): string {
  let cookieHeader = '';
  const response = { setHeader(_name: string, value: string) { cookieHeader = value; } } as unknown as Response;
  auth.createSession(response, { headers: {}, secure: false } as unknown as Request, principal);
  return cookieHeader.split(';', 1)[0]!;
}

test('server routes allow viewer reads, require operator for writes, and reserve recovery settings for admin', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-route-rbac-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new PanelAuthService(TOKEN, directory);
  await auth.initialize();
  await auth.createUser('viewer-test', 'viewer-test-password-long', 'viewer');
  await auth.createUser('operator-test', 'operator-test-password-long', 'operator');
  await auth.createUser('admin-test', 'admin-test-password-long', 'admin');
  const viewer = (await auth.authenticate({ username: 'viewer-test', password: 'viewer-test-password-long' }))!;
  const operator = (await auth.authenticate({ username: 'operator-test', password: 'operator-test-password-long' }))!;
  const admin = (await auth.authenticate({ username: 'admin-test', password: 'admin-test-password-long' }))!;

  const recovery: RecoverySnapshot = {
    settings: { restartAfterCrash: true, startAfterPanelRestart: false, maxAttempts: 5, delaySeconds: 10 },
    phase: 'idle',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    startupPending: false,
  };
  let updateCalls = 0;
  let snapshotCalls = 0;
  const auditEvents: string[] = [];
  const worldId = 'a1d8fbb4-9cda-4ed8-9466-c62cf3189f51';
  const dependencies = {
    auth,
    recovery: {
      getSnapshot: () => recovery,
      async updateSettings() { updateCalls += 1; return recovery; },
    },
    worldManager: {
      getWorld(id: string) { return { id, name: 'RBAC test world' }; },
    },
    snapshots: {
      async createSnapshot(id: string, reason: string) {
        snapshotCalls += 1;
        return { id: 'snapshot-id', worldId: id, worldName: 'RBAC test world', createdAt: new Date().toISOString(), reason, sizeBytes: 42 };
      },
      async getSnapshotWithDisk() { return { snapshots: [], storageUsedBytes: 0, diskFreeBytes: 1e9 }; },
    },
    audit: {
      async record(_principal: unknown, action: string) { auditEvents.push(action); },
      list: () => [],
    },
  } as unknown as ServerRouteDependencies;
  const app = express();
  app.use(express.json());
  app.use('/api/server', createServerRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (cookie: string, method: string, requestOrigin = origin) => fetch(`${origin}/api/server/recovery/settings`, {
    method,
    headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
    body: JSON.stringify(recovery.settings),
  });
  const viewerCookie = cookieFor(auth, viewer);
  const operatorCookie = cookieFor(auth, operator);
  const adminCookie = cookieFor(auth, admin);

  const read = await fetch(`${origin}/api/server/recovery`, { headers: { cookie: viewerCookie } });
  assert.equal(read.status, 200);
  const viewerWrite = await send(viewerCookie, 'PUT');
  assert.equal(viewerWrite.status, 403);
  const operatorWrite = await send(operatorCookie, 'PUT');
  assert.equal(operatorWrite.status, 403, 'operator cannot change admin recovery policy');
  const snapshotUrl = `${origin}/api/server/worlds/${worldId}/snapshots`;
  const operatorSnapshot = await fetch(snapshotUrl, {
    method: 'POST',
    headers: { cookie: operatorCookie, origin, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(operatorSnapshot.status, 201, 'operators may create routine manual snapshots');
  const viewerSnapshot = await fetch(snapshotUrl, {
    method: 'POST',
    headers: { cookie: viewerCookie, origin, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(viewerSnapshot.status, 403);
  assert.equal(snapshotCalls, 1);
  assert.equal(updateCalls, 0);

  const crossOriginWrite = await send(adminCookie, 'PUT', 'https://attacker.invalid');
  assert.equal(crossOriginWrite.status, 403);
  assert.equal(updateCalls, 0, 'same-origin validation runs before the setting update');

  const adminWrite = await send(adminCookie, 'PUT');
  assert.equal(adminWrite.status, 200);
  assert.equal(updateCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(auditEvents.includes('recovery-settings-updated'));
});
