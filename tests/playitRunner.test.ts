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
    'const secretExists = fs.existsSync(secretPath);',
    'const secret = secretExists ? fs.readFileSync(secretPath, "utf8") : null;',
    'const mode = secretExists ? (fs.statSync(secretPath).mode & 0o777) : null;',
    'fs.writeFileSync(process.env.PLAYIT_TEST_RECEIPT, JSON.stringify({ args, secretPath, secret, mode, secretEnv: process.env.PLAYIT_SECRET_KEY ?? null, panelToken: process.env.PANEL_TOKEN ?? null }));',
    'const hasSecret = Boolean(secret);',
    'const sockets = new Set();',
    'const lifecycle = process.env.PLAYIT_TEST_LIFECYCLE === "invalid"',
    '  ? { state: "has_invalid_secret", data: { message: "Fake invalid secret" } }',
    '  : hasSecret ? { state: "running", data: { tunnels: [{ display_address: "fake.joinmc.link:19132" }] } } : { state: "waiting_for_secret" };',
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
    '      const snapshot = { status: { has_secret: hasSecret }, lifecycle: snapshotLifecycle, stats: {} };',
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

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function saveEnvironment(names: string[]): () => void {
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function createFakeDaemon(directory: string): Promise<string> {
  const executable = path.join(directory, 'fake-playitd.cjs');
  await writeFile(executable, fakePlayitDaemonSource(), { encoding: 'utf8', mode: 0o755 });
  return executable;
}

async function waitForPlayitState(state: StateStore, predicate: (snapshot: ReturnType<StateStore['getSnapshot']>) => boolean): Promise<void> {
  if (predicate(state.getSnapshot())) return;
  await new Promise<void>((resolve, reject) => {
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

test('starts playitd through a private legacy file and reads the assigned address over IPC', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Playit daemon/Unix-socket integration test uses Linux.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-ipc-'));
  const restoreEnvironment = saveEnvironment(['PLAYIT_TEST_RECEIPT', 'PLAYIT_SECRET_KEY', 'PANEL_TOKEN', 'PLAYIT_TEST_LIFECYCLE']);
  let runner: PlayitRunner | null = null;
  try {
    const executable = await createFakeDaemon(directory);
    const receiptPath = path.join(directory, 'daemon-receipt.json');
    process.env.PLAYIT_TEST_RECEIPT = receiptPath;
    process.env.PLAYIT_SECRET_KEY = 'must-not-leak-secret';
    process.env.PANEL_TOKEN = 'must-not-leak-panel-token';
    process.env.PLAYIT_TEST_LIFECYCLE = 'event';

    const state = new StateStore(path.join(directory, 'state'));
    await state.initialize();
    runner = new PlayitRunner(executable, validSecret, state, { dataDirectory: path.join(directory, 'data') });

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
    await assert.rejects(access(receipt.secretPath), 'temporary legacy secret file is removed after the daemon loads it');

    await runner.shutdown();
    await state.flush();
    assert.equal(state.getSnapshot().playit.address, 'fake.joinmc.link:19132');
  } finally {
    restoreEnvironment();
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('keeps a claim URL in ephemeral dashboard state when the daemon has no secret', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Playit daemon/Unix-socket integration test uses Linux.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-claim-'));
  const restoreEnvironment = saveEnvironment(['PLAYIT_TEST_RECEIPT', 'PLAYIT_TEST_LIFECYCLE', 'PANEL_TOKEN']);
  let runner: PlayitRunner | null = null;
  try {
    const daemonPath = await createFakeDaemon(directory);
    const daemonReceipt = path.join(directory, 'daemon.json');
    process.env.PLAYIT_TEST_RECEIPT = daemonReceipt;
    delete process.env.PLAYIT_TEST_LIFECYCLE;
    process.env.PANEL_TOKEN = 'must-not-leak-panel-token';

    const cliPath = path.join(directory, 'fake-playit');
    await writeFile(cliPath, '#!/bin/sh\nprintf \'Open this link to finish setting up playit:\\nhttps://playit.gg/claim/0123456789\\n\'\nexec sleep 60\n', { encoding: 'utf8', mode: 0o755 });

    const dataDirectory = path.join(directory, 'data');
    const state = new StateStore(path.join(directory, 'state'));
    await state.initialize();
    await state.updatePlayit({
      status: 'running',
      address: 'old-agent.joinmc.link',
      addressDetectedAt: new Date().toISOString(),
      error: null,
    });
    runner = new PlayitRunner(daemonPath, undefined, state, { cliCommand: cliPath, dataDirectory });
    runner.startOnce();

    await waitForCondition(() => runner?.getSetupSnapshot().claimUrl === 'https://playit.gg/claim/0123456789', 'The claim URL was not detected from playit setup output.');
    await state.flush();
    const snapshot = runner.getSetupSnapshot();
    assert.equal(snapshot.phase, 'claim_pending');
    assert.equal(snapshot.claimUrl, 'https://playit.gg/claim/0123456789');
    assert.equal(state.getSnapshot().playit.status, 'claim_pending');
    assert.equal(state.getSnapshot().playit.address, null, 'an old public endpoint is cleared while awaiting setup');

    const receipt = JSON.parse(await readFile(daemonReceipt, 'utf8')) as {
      secretPath: string;
      secret: string | null;
      secretEnv: string | null;
      panelToken: string | null;
    };
    assert.equal(receipt.secret, null);
    assert.equal(receipt.secretEnv, null);
    assert.equal(receipt.panelToken, null);
    assert.equal(await access(receipt.secretPath).then(() => true, () => false), false, 'the daemon can wait for a secret without a key in .env');

    await runner.shutdown();
    await state.flush();
  } finally {
    restoreEnvironment();
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('preserves the Playit lifecycle error for a configured daemon with an invalid secret', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Playit daemon/Unix-socket integration test uses Linux.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-error-'));
  const restoreEnvironment = saveEnvironment(['PLAYIT_TEST_RECEIPT', 'PLAYIT_TEST_LIFECYCLE']);
  let runner: PlayitRunner | null = null;
  try {
    const executable = await createFakeDaemon(directory);
    const receiptPath = path.join(directory, 'daemon-receipt.json');
    process.env.PLAYIT_TEST_RECEIPT = receiptPath;
    process.env.PLAYIT_TEST_LIFECYCLE = 'invalid';

    const state = new StateStore(path.join(directory, 'state'));
    await state.initialize();
    runner = new PlayitRunner(executable, validSecret, state, { dataDirectory: path.join(directory, 'data') });
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
    restoreEnvironment();
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
