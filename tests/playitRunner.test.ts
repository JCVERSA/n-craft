import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlayitRunner } from '../src/playit/playitRunner.ts';
import { StateStore } from '../src/state.ts';

const validSecret = '0123456789abcdef0123456789abcdef';

function fakePlayitDaemonSource(): string {
  return [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    'const args = process.argv.slice(2);',
    'function arg(name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; }',
    'const socketPath = arg("--socket-path");',
    'const secretPath = arg("--secret-path");',
    'const secret = fs.readFileSync(secretPath, "utf8");',
    'const mode = fs.statSync(secretPath).mode & 0o777;',
    'fs.writeFileSync(process.env.PLAYIT_TEST_RECEIPT, JSON.stringify({ args, secretPath, secret, mode, secretEnv: process.env.PLAYIT_SECRET_KEY ?? null, panelToken: process.env.PANEL_TOKEN ?? null }));',
    'const sockets = new Set();',
    'const lifecycle = process.env.PLAYIT_TEST_LIFECYCLE === "invalid"',
    '  ? { state: "has_invalid_secret", data: { message: "Fake invalid secret" } }',
    '  : { state: "running", data: { tunnels: [{ display_address: "fake.joinmc.link:19132" }] } };',
    'const server = net.createServer((socket) => {',
    '  sockets.add(socket);',
    '  socket.setEncoding("utf8");',
    '  socket.write(JSON.stringify({ message_kind: "hello", data: { protocol: { ipc_version: 2, capabilities: [] } } }) + "\\n");',
    '  let buffer = "";',
    '  socket.on("data", (chunk) => {',
    '    buffer += chunk;',
    '    let newline;',
    '    while ((newline = buffer.indexOf("\\n")) >= 0) {',
    '      const line = buffer.slice(0, newline);',
    '      buffer = buffer.slice(newline + 1);',
    '      const request = JSON.parse(line);',
    '      if (request.request?.type !== "subscribe") continue;',
    '      const snapshotLifecycle = process.env.PLAYIT_TEST_LIFECYCLE === "event" ? { state: "starting" } : lifecycle;',
    '      const snapshot = { status: { has_secret: true }, lifecycle: snapshotLifecycle, stats: {} };',
    '      const response = { type: "subscribe", data: { protocol: { ipc_version: 2, capabilities: [] }, snapshot } };',
    '      socket.write(JSON.stringify({ message_kind: "response", data: { ipc_version: 2, request_id: request.request_id, response } }) + "\\n");',
    '      if (process.env.PLAYIT_TEST_LIFECYCLE === "event") setTimeout(() => socket.write(JSON.stringify({ message_kind: "event", data: { ipc_version: 2, event: { type: "lifecycle", data: lifecycle } } }) + "\\n"), 25);',
    '    }',
    '  });',
    '  socket.on("close", () => sockets.delete(socket));',
    '});',
    'server.listen(socketPath);',
    'process.on("SIGTERM", () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });',
    '',
  ].join('\n');
}

function waitForPlayitState(state: StateStore, predicate: (snapshot: ReturnType<StateStore['getSnapshot']>) => boolean): Promise<void> {
  if (predicate(state.getSnapshot())) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.removeListener('change', onChange);
      reject(new Error('Timed out waiting for Playit state.'));
    }, 5000);
    const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      state.removeListener('change', onChange);
      resolve();
    };
    state.on('change', onChange);
  });
}

test('starts playitd through a private secret file and reads the assigned address over IPC', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Playit daemon/Unix-socket integration test uses Linux.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-ipc-'));
  const previousReceipt = process.env.PLAYIT_TEST_RECEIPT;
  const previousSecretEnvironment = process.env.PLAYIT_SECRET_KEY;
  const previousPanelToken = process.env.PANEL_TOKEN;
  const previousLifecycle = process.env.PLAYIT_TEST_LIFECYCLE;
  let runner: PlayitRunner | null = null;
  try {
    const executable = path.join(directory, 'fake-playitd.cjs');
    const receiptPath = path.join(directory, 'daemon-receipt.json');
    process.env.PLAYIT_TEST_RECEIPT = receiptPath;
    process.env.PLAYIT_SECRET_KEY = 'must-not-leak-secret';
    process.env.PANEL_TOKEN = 'must-not-leak-panel-token';
    process.env.PLAYIT_TEST_LIFECYCLE = 'event';
    await writeFile(executable, fakePlayitDaemonSource(), { encoding: 'utf8', mode: 0o755 });

    const state = new StateStore(path.join(directory, 'data'));
    await state.initialize();
    runner = new PlayitRunner(executable, validSecret, state);

    const assignedAddress = waitForPlayitState(state, (snapshot) => snapshot.playit.address === 'fake.joinmc.link:19132');
    runner.startOnce();
    await assignedAddress;
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      args: string[];
      secretPath: string;
      secret: string;
      mode: number;
      secretEnv: string | null;
      panelToken: string | null;
    };
    assert.equal(receipt.secret, validSecret);
    assert.equal(receipt.mode, 0o600);
    assert.ok(receipt.args.includes('--secret-path'));
    assert.ok(receipt.args.includes('--socket-path'));
    assert.ok(receipt.args.includes('--platform-docker'));
    assert.ok(!receipt.args.includes(validSecret), 'secret must not appear in the daemon argument list');
    assert.equal(receipt.secretEnv, null, 'secret must not be inherited through the environment');
    assert.equal(receipt.panelToken, null, 'panel credential must not be inherited by the daemon');
    await assert.rejects(access(receipt.secretPath), 'secret file is removed after playitd reports its configured state');

    await runner.shutdown();
    await state.flush();
    assert.equal(state.getSnapshot().playit.status, 'exited');
    assert.equal(state.getSnapshot().playit.address, null);
  } finally {
    if (previousReceipt === undefined) delete process.env.PLAYIT_TEST_RECEIPT;
    else process.env.PLAYIT_TEST_RECEIPT = previousReceipt;
    if (previousSecretEnvironment === undefined) delete process.env.PLAYIT_SECRET_KEY;
    else process.env.PLAYIT_SECRET_KEY = previousSecretEnvironment;
    if (previousPanelToken === undefined) delete process.env.PANEL_TOKEN;
    else process.env.PANEL_TOKEN = previousPanelToken;
    if (previousLifecycle === undefined) delete process.env.PLAYIT_TEST_LIFECYCLE;
    else process.env.PLAYIT_TEST_LIFECYCLE = previousLifecycle;
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('preserves the Playit lifecycle error when stopping a daemon with an invalid secret', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Playit daemon/Unix-socket integration test uses Linux.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-error-'));
  const previousReceipt = process.env.PLAYIT_TEST_RECEIPT;
  const previousLifecycle = process.env.PLAYIT_TEST_LIFECYCLE;
  let runner: PlayitRunner | null = null;
  try {
    const executable = path.join(directory, 'fake-playitd.cjs');
    const receiptPath = path.join(directory, 'daemon-receipt.json');
    process.env.PLAYIT_TEST_RECEIPT = receiptPath;
    process.env.PLAYIT_TEST_LIFECYCLE = 'invalid';
    await writeFile(executable, fakePlayitDaemonSource(), { encoding: 'utf8', mode: 0o755 });

    const state = new StateStore(path.join(directory, 'data'));
    await state.initialize();
    runner = new PlayitRunner(executable, validSecret, state);
    const failed = waitForPlayitState(state, (snapshot) => snapshot.playit.status === 'failed');
    runner.startOnce();
    await failed;
    await runner.shutdown();
    await state.flush();

    assert.equal(state.getSnapshot().playit.status, 'failed');
    assert.match(state.getSnapshot().playit.error ?? '', /Fake invalid secret/);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { secretPath: string };
    await assert.rejects(access(receipt.secretPath));
  } finally {
    if (previousReceipt === undefined) delete process.env.PLAYIT_TEST_RECEIPT;
    else process.env.PLAYIT_TEST_RECEIPT = previousReceipt;
    if (previousLifecycle === undefined) delete process.env.PLAYIT_TEST_LIFECYCLE;
    else process.env.PLAYIT_TEST_LIFECYCLE = previousLifecycle;
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('clears a persisted Playit address when the daemon cannot be configured', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-state-'));
  try {
    const state = new StateStore(directory);
    await state.initialize();
    await state.updatePlayit({
      status: 'running',
      address: 'old-agent.joinmc.link',
      addressDetectedAt: new Date().toISOString(),
      error: null,
    });
    await state.flush();

    const runner = new PlayitRunner('playitd', undefined, state);
    runner.startOnce();
    await state.flush();

    assert.equal(state.getSnapshot().playit.status, 'configuration_missing');
    assert.equal(state.getSnapshot().playit.address, null);
    assert.equal(state.getSnapshot().playit.addressDetectedAt, null);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
