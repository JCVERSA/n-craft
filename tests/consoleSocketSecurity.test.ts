import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';
import { WebSocket } from 'ws';
import { PanelAuthService, type PanelPrincipal } from '../src/auth.ts';
import { attachConsoleWebSocket, type BedrockConsole } from '../src/bedrock/console.ts';
import { StateStore } from '../src/state.ts';
import type { AuditLog } from '../src/audit.ts';

const TOKEN = 'console-socket-test-panel-token-with-thirty-two-bytes';

function cookieFor(auth: PanelAuthService, principal: PanelPrincipal): string {
  let cookieHeader = '';
  const response = { setHeader(_name: string, value: string) { cookieHeader = value; } } as unknown as Response;
  auth.createSession(response, { headers: {}, secure: false } as unknown as Request, principal);
  return cookieHeader.split(';', 1)[0]!;
}

class StubConsole extends EventEmitter {
  sentCommands: string[] = [];

  getRecentLines() {
    return [];
  }

  sendCommand(command: string): boolean {
    this.sentCommands.push(command);
    return true;
  }
}

test('console WebSocket enforces production HTTPS, viewer redaction, admin-only privilege commands, auditing, and immediate session revocation', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-ws-security-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const auth = new PanelAuthService(TOKEN, directory);
  await auth.initialize();
  const viewerSummary = await auth.createUser('ws-viewer', 'ws-viewer-password-long', 'viewer');
  await auth.createUser('ws-operator', 'ws-operator-password-long', 'operator');
  await auth.createUser('ws-admin', 'ws-admin-password-long', 'admin');
  const viewer = (await auth.authenticate({ username: 'ws-viewer', password: 'ws-viewer-password-long' }))!;
  const operator = (await auth.authenticate({ username: 'ws-operator', password: 'ws-operator-password-long' }))!;
  const admin = (await auth.authenticate({ username: 'ws-admin', password: 'ws-admin-password-long' }))!;

  const state = new StateStore(directory);
  await state.initialize();
  await state.setActiveConfig({
    version: '1.21.131.1',
    serverName: 'WS Test',
    levelName: 'ncraft_ws_world',
    gamemode: 'survival',
    difficulty: 'normal',
    maxPlayers: 10,
    adminXuids: ['2535412894129841'],
    seed: 'ws-secret-seed',
    viewDistance: 10,
    allowCheats: false,
    eulaAccepted: true,
  });

  const bedrock = new StubConsole();
  const audited: Array<{ role: string; action: string; detail: string }> = [];
  const audit: Pick<AuditLog, 'record'> = {
    async record(principal, action, detail = '') {
      audited.push({ role: principal?.role ?? 'none', action, detail });
    },
  };

  const server = createServer();
  const gateway = attachConsoleWebSocket(server, auth, bedrock as unknown as BedrockConsole, state, audit);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await gateway.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const wsUrl = `ws://127.0.0.1:${address.port}/api/server/console`;
  const origin = `http://127.0.0.1:${address.port}`;

  const viewerCookie = cookieFor(auth, viewer);
  const operatorCookie = cookieFor(auth, operator);
  const adminCookie = cookieFor(auth, admin);

  // 1. Production mode rejects plain HTTP WebSocket upgrade.
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const plainWs = new WebSocket(wsUrl, { headers: { cookie: adminCookie, origin } });
    const statusCode = await new Promise<number>((resolve, reject) => {
      plainWs.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      plainWs.once('open', () => reject(new Error('Expected plain WS upgrade to fail in production')));
    });
    assert.equal(statusCode, 403);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }

  // 2. Viewer receives redacted snapshot and is closed immediately when deleted.
  const viewerWs = new WebSocket(wsUrl, { headers: { cookie: viewerCookie, origin } });
  const viewerSnapshotPromise = once(viewerWs, 'message');
  await once(viewerWs, 'open');
  const [viewerRaw] = await viewerSnapshotPromise;
  const viewerMsg = JSON.parse(viewerRaw.toString()) as { type: string; state: { activeConfig: { seed: string; adminXuids: string[] } } };
  assert.equal(viewerMsg.type, 'snapshot');
  assert.equal(viewerMsg.state.activeConfig.seed, '');
  assert.deepEqual(viewerMsg.state.activeConfig.adminXuids, []);

  const viewerClosed = once(viewerWs, 'close') as Promise<[number, Buffer]>;
  await auth.deleteUser(viewerSummary.id);
  const [closeCode] = await viewerClosed;
  assert.equal(closeCode, 4401);

  // 3. Operator may send routine commands (audited) but not privileged commands (op / allowlist).
  const operatorWs = new WebSocket(wsUrl, { headers: { cookie: operatorCookie, origin } });
  const operatorInitial = once(operatorWs, 'message');
  await once(operatorWs, 'open');
  await operatorInitial;

  const opErrorPromise = once(operatorWs, 'message');
  operatorWs.send(JSON.stringify({ type: 'command', command: 'op Intruder' }));
  const [opErrorRaw] = await opErrorPromise;
  const opError = JSON.parse(opErrorRaw.toString()) as { type: string; error: string };
  assert.equal(opError.type, 'error');
  assert.match(opError.error, /administrateur/i);
  assert.deepEqual(bedrock.sentCommands, []);

  operatorWs.send(JSON.stringify({ type: 'command', command: 'say Bonjour' }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(bedrock.sentCommands, ['say Bonjour']);
  assert.equal(audited.length, 1);
  assert.equal(audited[0]?.role, 'operator');
  assert.equal(audited[0]?.action, 'bedrock-console-command');
  operatorWs.close();

  // 4. Admin may send op command and is audited.
  const adminWs = new WebSocket(wsUrl, { headers: { cookie: adminCookie, origin } });
  const adminInitial = once(adminWs, 'message');
  await once(adminWs, 'open');
  const [adminSnapRaw] = await adminInitial;
  const adminSnap = JSON.parse(adminSnapRaw.toString()) as { state: { activeConfig: { seed: string } } };
  assert.equal(adminSnap.state.activeConfig.seed, 'ws-secret-seed');

  adminWs.send(JSON.stringify({ type: 'command', command: 'op TrustedAdmin' }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(bedrock.sentCommands, ['say Bonjour', 'op TrustedAdmin']);
  assert.equal(audited.length, 2);
  assert.equal(audited[1]?.role, 'admin');
  adminWs.close();
});
