import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PortwarpRunner, parsePortwarpAddress, parsePortwarpMapping, parsePortwarpTunnelAddress } from '../src/portwarp/portwarpRunner.ts';
import { StateStore } from '../src/state.ts';

function fakePwrpSource(): string {
  return [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const authFile = process.env.PORTWARP_TEST_AUTH_FILE;',
    'const receiptFile = process.env.PORTWARP_TEST_RECEIPT;',
    'const commandLog = process.env.PORTWARP_TEST_COMMAND_LOG;',
    'const deviceCode = process.env.PORTWARP_TEST_DEVICE_CODE;',
    'const mode = process.env.PORTWARP_TEST_MODE || "connected";',
    'if (commandLog) fs.appendFileSync(commandLog, JSON.stringify(args) + "\\n");',
    'if (args[0] === "status") {',
    '  if (fs.existsSync(authFile)) { console.log("Signed in as test-account"); process.exit(0); }',
    '  console.error("Not signed in. Run pwrp login."); process.exit(1);',
    '}',
    'if (args[0] === "login") {',
    '  console.log("Authorize this device at https://portwarp.com/device");',
    '  console.log("Your one-time code: " + deviceCode);',
    '  const timer = setInterval(() => {',
    '    if (!fs.existsSync(authFile)) return;',
    '    console.log("Approved"); clearInterval(timer); process.exit(0);',
    '  }, 10);',
    '  process.on("SIGTERM", () => { clearInterval(timer); process.exit(143); });',
    '  return;',
    '}',
    'if (args[0] === "connect") {',
    '  const record = { args, panelToken: process.env.PANEL_TOKEN ?? null, localtonetAuth: process.env.LOCALTONET_AUTH_TOKEN ?? null, localtonetApi: process.env.LOCALTONET_API_KEY ?? null, playitSecret: process.env.PLAYIT_SECRET_KEY ?? null };',
    '  if (receiptFile) fs.appendFileSync(receiptFile, JSON.stringify(record) + "\\n");',
    '  if (mode === "missing") { console.error("No matching enabled tunnels found."); process.exit(1); }',
    '  if (mode === "wrong-mapping") { console.log("Minecraft Bedrock TCP 25565 → 25565"); process.exit(0); }',
    '  console.log("Starting tunnel(s)…");',
    '  console.log("✓ Minecraft Bedrock UDP 19132 → 15945");',
    '  console.log("address: un379qa9.free.pwrp.cc:15945");',
    '  console.log("1 session(s) running in background");',
    '  process.exit(0);',
    '}',
    'if (args[0] === "ps") { console.log("c659313e Minecraft Bedrock UDP 19132 → 15945 ● live Local n/a"); process.exit(0); }',
    'if (args[0] === "tunnels") { console.log("Minecraft Bedrock UDP 19132 → 15945 un379qa9.free.pwrp.cc:15945"); process.exit(0); }',
    'if (args[0] === "stop") { process.exit(0); }',
    'console.error("Unexpected fake pwrp command", args[0]); process.exit(2);',
    '',
  ].join('\n');
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function waitForPortwarpState(
  state: StateStore,
  predicate: (snapshot: ReturnType<StateStore['getSnapshot']>) => boolean,
): Promise<void> {
  if (predicate(state.getSnapshot())) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.removeListener('change', onChange);
      reject(new Error('Timed out waiting for Portwarp state.'));
    }, 5_000);
    const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      state.removeListener('change', onChange);
      resolve();
    };
    state.on('change', onChange);
  });
}

function saveEnvironment(names: string[]): () => void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function createFakePwrp(directory: string): Promise<string> {
  const binary = path.join(directory, 'fake-pwrp.cjs');
  await writeFile(binary, fakePwrpSource(), { encoding: 'utf8', mode: 0o755 });
  return binary;
}

test('runs pwrp login as an ephemeral device flow, then saves and connects the existing UDP tunnel', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-portwarp-login-'));
  const restoreEnvironment = saveEnvironment([
    'PORTWARP_TEST_AUTH_FILE', 'PORTWARP_TEST_RECEIPT', 'PORTWARP_TEST_COMMAND_LOG', 'PORTWARP_TEST_DEVICE_CODE', 'PORTWARP_TEST_MODE',
    'PANEL_TOKEN', 'LOCALTONET_AUTH_TOKEN', 'LOCALTONET_API_KEY', 'PLAYIT_SECRET_KEY',
  ]);
  let runner: PortwarpRunner | null = null;
  t.after(async () => {
    restoreEnvironment();
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const binary = await createFakePwrp(directory);
  const authFile = path.join(directory, 'approved');
  const deviceCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const receipt = path.join(directory, 'connect.ndjson');
  const commandLog = path.join(directory, 'commands.ndjson');
  const dataDirectory = path.join(directory, 'data');
  process.env.PORTWARP_TEST_AUTH_FILE = authFile;
  process.env.PORTWARP_TEST_RECEIPT = receipt;
  process.env.PORTWARP_TEST_COMMAND_LOG = commandLog;
  process.env.PORTWARP_TEST_DEVICE_CODE = deviceCode;
  process.env.PORTWARP_TEST_MODE = 'connected';
  process.env.PANEL_TOKEN = 'panel-secret-must-not-be-inherited';
  process.env.LOCALTONET_AUTH_TOKEN = 'localtonet-secret-must-not-be-inherited';
  process.env.LOCALTONET_API_KEY = 'localtonet-key-must-not-be-inherited';
  process.env.PLAYIT_SECRET_KEY = 'playit-secret-must-not-be-inherited';

  const state = new StateStore(dataDirectory);
  await state.initialize();
  runner = new PortwarpRunner(state, { binaryCommand: binary, pollIntervalMs: 5_000 });
  runner.startOnce();

  await waitForCondition(
    () => runner?.getSetupSnapshot().phase === 'waiting_for_approval' && runner.getSetupSnapshot().userCode === deviceCode,
    'The short-lived device code was not exposed to the authenticated setup snapshot.',
  );
  assert.equal(runner.getSetupSnapshot().verificationUrl, 'https://portwarp.com/device');
  await state.flush();
  const beforeApproval = await readFile(path.join(dataDirectory, 'state.json'), 'utf8');
  assert.ok(!beforeApproval.includes(deviceCode), 'temporary device code must not be persisted');
  assert.doesNotMatch(beforeApproval, /portwarp\.com\/device/);
  assert.doesNotMatch(beforeApproval, /panel-secret|localtonet-secret|playit-secret/);
  assert.equal(state.getSnapshot().portwarp.status, 'awaiting_approval');

  await writeFile(authFile, 'approved');
  await waitForPortwarpState(state, (snapshot) =>
    snapshot.portwarp.status === 'running' && snapshot.portwarp.address === 'un379qa9.free.pwrp.cc:15945',
  );
  assert.equal(runner.getSetupSnapshot().phase, 'authenticated');
  assert.equal(runner.getSetupSnapshot().userCode, null, 'the device code is cleared as soon as login finishes');

  const command = JSON.parse((await readFile(receipt, 'utf8')).trim()) as {
    args: string[];
    panelToken: string | null;
    localtonetAuth: string | null;
    localtonetApi: string | null;
    playitSecret: string | null;
  };
  assert.deepEqual(command.args, ['connect', 'Minecraft Bedrock', '--save', '--detach']);
  assert.equal(command.panelToken, null);
  assert.equal(command.localtonetAuth, null);
  assert.equal(command.localtonetApi, null);
  assert.equal(command.playitSecret, null);
  assert.equal(state.getSnapshot().portwarp.localPort, 19132);
  assert.equal(state.getSnapshot().portwarp.publicPort, 15945);
  assert.equal(state.getSnapshot().portwarp.status, 'running');

  await runner.shutdown();
  await state.flush();
  const persisted = await readFile(path.join(dataDirectory, 'state.json'), 'utf8');
  assert.ok(!persisted.includes(deviceCode), 'temporary device code must not be persisted');
  const commands = (await readFile(commandLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
  assert.ok(!commands.some((args) => args[0] === 'stop'), 'panel runner shutdown must never stop a detached tunnel');
});

test('reports a missing existing tunnel without creating or deleting anything', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-portwarp-missing-'));
  const restoreEnvironment = saveEnvironment(['PORTWARP_TEST_AUTH_FILE', 'PORTWARP_TEST_RECEIPT', 'PORTWARP_TEST_MODE']);
  let runner: PortwarpRunner | null = null;
  t.after(async () => {
    restoreEnvironment();
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const binary = await createFakePwrp(directory);
  const authFile = path.join(directory, 'approved');
  const receipt = path.join(directory, 'connect.ndjson');
  process.env.PORTWARP_TEST_AUTH_FILE = authFile;
  process.env.PORTWARP_TEST_RECEIPT = receipt;
  process.env.PORTWARP_TEST_MODE = 'missing';
  await writeFile(authFile, 'already approved');

  const state = new StateStore(path.join(directory, 'data'));
  await state.initialize();
  runner = new PortwarpRunner(state, { binaryCommand: binary, pollIntervalMs: 5_000 });
  runner.startOnce();
  await waitForPortwarpState(state, (snapshot) => snapshot.portwarp.status === 'tunnel_missing');
  assert.match(state.getSnapshot().portwarp.error ?? '', /UDP vers 19132/);
  assert.equal(runner.getSetupSnapshot().userCode, null);
  const record = JSON.parse((await readFile(receipt, 'utf8')).trim()) as { args: string[] };
  assert.deepEqual(record.args, ['connect', 'Minecraft Bedrock', '--save', '--detach']);
  await runner.shutdown();
});

test('reports a tunnel configured for the wrong protocol or local port', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-portwarp-misconfigured-'));
  const restoreEnvironment = saveEnvironment(['PORTWARP_TEST_AUTH_FILE', 'PORTWARP_TEST_RECEIPT', 'PORTWARP_TEST_MODE']);
  let runner: PortwarpRunner | null = null;
  t.after(async () => {
    restoreEnvironment();
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const binary = await createFakePwrp(directory);
  process.env.PORTWARP_TEST_AUTH_FILE = path.join(directory, 'approved');
  process.env.PORTWARP_TEST_RECEIPT = path.join(directory, 'connect.ndjson');
  process.env.PORTWARP_TEST_MODE = 'wrong-mapping';
  await writeFile(process.env.PORTWARP_TEST_AUTH_FILE, 'already approved');

  const state = new StateStore(path.join(directory, 'data'));
  await state.initialize();
  runner = new PortwarpRunner(state, { binaryCommand: binary, pollIntervalMs: 5_000 });
  runner.startOnce();
  await waitForPortwarpState(state, (snapshot) => snapshot.portwarp.status === 'tunnel_misconfigured');
  assert.match(state.getSnapshot().portwarp.error ?? '', /Bedrock exige UDP 19132/);
  assert.equal(state.getSnapshot().portwarp.address, null);
  await runner.shutdown();
});

test('parses public endpoints and UDP mappings from pwrp output', () => {
  assert.equal(parsePortwarpAddress('address: un379qa9.free.pwrp.cc:15945'), 'un379qa9.free.pwrp.cc:15945');
  assert.equal(parsePortwarpAddress('Local 127.0.0.1:19132 ● live'), null, 'a local target must not be presented as a public address');
  assert.equal(parsePortwarpAddress('address: 203.0.113.44:15945'), '203.0.113.44:15945');
  assert.equal(parsePortwarpMapping('✓ Minecraft Bedrock UDP 19132 → 15945')?.protocol, 'UDP');
  assert.deepEqual(parsePortwarpMapping('UDP 19132 -> 15945'), { protocol: 'UDP', localPort: 19132, publicPort: 15945 });
  assert.equal(parsePortwarpMapping('TCP 25565 -> 25565')?.localPort, 25565);
  assert.equal(
    parsePortwarpTunnelAddress('Minecraft Bedrock UDP 19132 → 15945 Texas-1 un379qa9.free.pwrp.cc:15945', 'Minecraft Bedrock'),
    'un379qa9.free.pwrp.cc:15945',
  );
  assert.equal(
    parsePortwarpTunnelAddress('Minecraft B… UDP 19132 → 15945 Texas-1 un379qa9.free.pwrp.cc:15945', 'Minecraft Bedrock'),
    'un379qa9.free.pwrp.cc:15945',
  );
  assert.equal(
    parsePortwarpTunnelAddress('127.0.0.1:19132 198.51.100.4:19132', 'Minecraft Bedrock'),
    null,
    'an ambiguous tunnel listing must not be guessed',
  );
});
