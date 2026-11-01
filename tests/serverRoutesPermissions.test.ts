import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServerRouter, type ServerRouteDependencies } from '../src/routes/server.routes.ts';
import { PanelAuthService, type PanelPrincipal } from '../src/auth.ts';
import { WorldManagerError } from '../src/bedrock/worldManager.ts';
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

test('pack routes allow viewer reads but reserve import and activation for same-origin admins', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-pack-route-rbac-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new PanelAuthService(TOKEN, directory);
  await auth.initialize();
  await auth.createUser('pack-viewer', 'pack-viewer-password-long', 'viewer');
  await auth.createUser('pack-operator', 'pack-operator-password-long', 'operator');
  await auth.createUser('pack-admin', 'pack-admin-password-long', 'admin');
  const viewer = (await auth.authenticate({ username: 'pack-viewer', password: 'pack-viewer-password-long' }))!;
  const operator = (await auth.authenticate({ username: 'pack-operator', password: 'pack-operator-password-long' }))!;
  const admin = (await auth.authenticate({ username: 'pack-admin', password: 'pack-admin-password-long' }))!;
  const dependencies = {
    auth,
    state: { getSnapshot: () => ({ server: { status: 'stopped', pid: null } }) },
    bedrockConsole: { isRunning: true },
    pipeline: { isRunning: false },
    worldManager: {
      isBusy: false,
      async withExclusiveOperation<T>(operation: () => Promise<T>) { return operation(); },
      getWorld() { throw new WorldManagerError('World not found.', 404); },
    },
    audit: { async record() {} },
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
  const viewerCookie = cookieFor(auth, viewer);
  const operatorCookie = cookieFor(auth, operator);
  const adminCookie = cookieFor(auth, admin);
  const headers = (cookie: string, requestOrigin = origin) => ({ cookie, origin: requestOrigin, 'content-type': 'application/json' });
  const worldId = 'a1d8fbb4-9cda-4ed8-9466-c62cf3189f51';

  const viewerRead = await fetch(`${origin}/api/server/worlds/${worldId}/packs`, { headers: headers(viewerCookie) });
  assert.equal(viewerRead.status, 404, 'viewer reads are allowed and reach the world lookup');

  for (const requestPath of ['/api/server/packs/import', `/api/server/worlds/${worldId}/packs/123e4567-e89b-12d3-a456-426614174000`]) {
    const method = requestPath.endsWith('/import') ? 'POST' : 'PUT';
    const body = method === 'PUT' ? JSON.stringify({ enabled: true }) : undefined;
    const viewerWrite = await fetch(`${origin}${requestPath}`, { method, headers: headers(viewerCookie), body });
    assert.equal(viewerWrite.status, 403, 'viewers cannot modify packs');
    const operatorWrite = await fetch(`${origin}${requestPath}`, { method, headers: headers(operatorCookie), body });
    assert.equal(operatorWrite.status, 403, 'operators cannot modify packs');
    const crossOriginAdmin = await fetch(`${origin}${requestPath}`, {
      method,
      headers: headers(adminCookie, 'https://attacker.invalid'),
      body,
    });
    assert.equal(crossOriginAdmin.status, 403, 'admin pack mutations remain same-origin protected');
    const adminWrite = await fetch(`${origin}${requestPath}`, { method, headers: headers(adminCookie), body });
    assert.equal(adminWrite.status, 409, 'same-origin admins reach the stopped-server safety check');
  }
});

test('strict RBAC reserves world deletion and adminXuids changes for admins, blocks viewer downloads, and audits mutations', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-strict-rbac-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new PanelAuthService(TOKEN, directory);
  await auth.initialize();
  await auth.createUser('strict-viewer', 'strict-viewer-password-long', 'viewer');
  await auth.createUser('strict-operator', 'strict-operator-password-long', 'operator');
  await auth.createUser('strict-admin', 'strict-admin-password-long', 'admin');
  const viewer = (await auth.authenticate({ username: 'strict-viewer', password: 'strict-viewer-password-long' }))!;
  const operator = (await auth.authenticate({ username: 'strict-operator', password: 'strict-operator-password-long' }))!;
  const admin = (await auth.authenticate({ username: 'strict-admin', password: 'strict-admin-password-long' }))!;

  const worldId = 'a1d8fbb4-9cda-4ed8-9466-c62cf3189f51';
  const baseConfig = {
    version: '1.21.131.1',
    serverName: 'Strict RBAC Server',
    levelName: 'ncraft_strict_world',
    gamemode: 'survival' as const,
    difficulty: 'normal' as const,
    maxPlayers: 10,
    adminXuids: ['2535412894129841'],
    seed: '998877',
    viewDistance: 10,
    allowCheats: false,
    eulaAccepted: true,
  };
  let savedConfigs = 0;
  let deletedWorlds = 0;
  const auditEvents: string[] = [];

  const dependencies = {
    auth,
    catalog: {
      allowedVersionIds: () => ['1.21.131.1'],
      get: (v: string) => (v === '1.21.131.1' ? { version: v } : null),
    },
    state: {
      getSnapshot: () => ({
        server: { status: 'stopped', pid: null },
        pipeline: { status: 'idle' },
        activeConfig: baseConfig,
      }),
      async setActiveConfig() {},
    },
    bedrockConsole: { isRunning: false },
    pipeline: {
      isRunning: false,
      async saveConfiguration() { savedConfigs += 1; },
    },
    worldManager: {
      isBusy: false,
      getWorld: (id: string) => ({
        id,
        name: 'Strict World',
        folder: baseConfig.levelName,
        version: baseConfig.version,
        seed: baseConfig.seed,
        configuration: baseConfig,
      }),
      findByVersionAndFolder: () => ({
        id: worldId,
        name: 'Strict World',
        folder: baseConfig.levelName,
        version: baseConfig.version,
        seed: baseConfig.seed,
        configuration: baseConfig,
      }),
      async updateConfiguration() {},
      async deleteWorld(id: string) { deletedWorlds += 1; return { id }; },
      async createWorldArchive() { throw new WorldManagerError('Archive stub reached.', 404); },
    },
    snapshots: {
      async getArchive() { throw new Error('Snapshot archive stub reached.'); },
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
  const viewerCookie = cookieFor(auth, viewer);
  const operatorCookie = cookieFor(auth, operator);
  const adminCookie = cookieFor(auth, admin);
  const headers = (cookie: string) => ({ cookie, origin, 'content-type': 'application/json' });

  // Viewer cannot download world or snapshot archives.
  assert.equal((await fetch(`${origin}/api/server/worlds/${worldId}/export`, { headers: { cookie: viewerCookie } })).status, 403);
  assert.equal((await fetch(`${origin}/api/server/snapshots/snap-1/download`, { headers: { cookie: viewerCookie } })).status, 403);
  // Operator reaches archive lookup.
  assert.equal((await fetch(`${origin}/api/server/worlds/${worldId}/export`, { headers: { cookie: operatorCookie } })).status, 404);

  // Operator cannot change adminXuids via POST /configuration, but may change maxPlayers while keeping adminXuids identical.
  const operatorEscalate = await fetch(`${origin}/api/server/configuration`, {
    method: 'POST',
    headers: headers(operatorCookie),
    body: JSON.stringify({ config: { ...baseConfig, adminXuids: ['9999999999999999'] } }),
  });
  assert.equal(operatorEscalate.status, 403);
  assert.equal(savedConfigs, 0);

  const operatorRoutineSave = await fetch(`${origin}/api/server/configuration`, {
    method: 'POST',
    headers: headers(operatorCookie),
    body: JSON.stringify({ config: { ...baseConfig, maxPlayers: 16 } }),
  });
  assert.equal(operatorRoutineSave.status, 200);
  assert.equal(savedConfigs, 1);
  assert.ok(auditEvents.includes('bedrock-configuration-saved'));

  // Admin can change adminXuids via POST /configuration.
  const adminSave = await fetch(`${origin}/api/server/configuration`, {
    method: 'POST',
    headers: headers(adminCookie),
    body: JSON.stringify({ config: { ...baseConfig, adminXuids: ['9999999999999999'] } }),
  });
  assert.equal(adminSave.status, 200);
  assert.equal(savedConfigs, 2);

  // World deletion requires admin and records an audit event.
  const operatorDelete = await fetch(`${origin}/api/server/worlds/${worldId}`, {
    method: 'DELETE',
    headers: headers(operatorCookie),
    body: JSON.stringify({ confirmName: 'Strict World' }),
  });
  assert.equal(operatorDelete.status, 403);
  assert.equal(deletedWorlds, 0);

  const adminDelete = await fetch(`${origin}/api/server/worlds/${worldId}`, {
    method: 'DELETE',
    headers: headers(adminCookie),
    body: JSON.stringify({ confirmName: 'Strict World' }),
  });
  assert.equal(adminDelete.status, 200);
  assert.equal(deletedWorlds, 1);
  assert.ok(auditEvents.includes('world-deleted'));
});

