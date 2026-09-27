import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocaltonetRunner } from '../src/localtonet/localtonetRunner.ts';
import { StateStore } from '../src/state.ts';

function saveEnvironment(names: string[]): () => void {
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function waitForLocaltonetAddress(state: StateStore): Promise<void> {
  if (state.getSnapshot().localtonet.address === 'bedrock.example.net:30001') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.removeListener('change', onChange);
      reject(new Error('Timed out waiting for the Localtonet endpoint.'));
    }, 5000);
    const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
      if (snapshot.localtonet.address !== 'bedrock.example.net:30001') return;
      clearTimeout(timer);
      state.removeListener('change', onChange);
      resolve();
    };
    state.on('change', onChange);
  });
}

test('starts the headless Localtonet client with a private token file and persists only public status', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The fake Localtonet client integration test uses a Linux executable.');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-localtonet-test-'));
  const restoreEnvironment = saveEnvironment([
    'LOCALTONET_AUTH_TOKEN',
    'LOCALTONET_API_KEY',
    'LOCALTONET_TEST_RECEIPT',
    'PANEL_TOKEN',
  ]);
  let runner: LocaltonetRunner | null = null;
  try {
    const dataDirectory = path.join(directory, 'data');
    await mkdir(dataDirectory, { recursive: true });
    const state = new StateStore(path.join(directory, 'state'));
    await state.initialize();
    const receiptPath = path.join(directory, 'client-receipt.json');
    const clientPath = path.join(directory, 'fake-localtonet.cjs');
    await writeFile(clientPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'const tokenPath = args[args.indexOf("--authtoken-file") + 1];',
      'fs.writeFileSync(process.env.LOCALTONET_TEST_RECEIPT, JSON.stringify({ args, token: fs.readFileSync(tokenPath, "utf8").trim(), tokenMode: fs.statSync(tokenPath).mode & 0o777, authEnv: process.env.LOCALTONET_AUTH_TOKEN ?? null, apiEnv: process.env.LOCALTONET_API_KEY ?? null, panelToken: process.env.PANEL_TOKEN ?? null }));',
      'process.on("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });

    process.env.LOCALTONET_AUTH_TOKEN = 'auth-token-that-must-not-persist';
    process.env.LOCALTONET_API_KEY = 'api-key-that-must-not-persist';
    process.env.LOCALTONET_TEST_RECEIPT = receiptPath;
    process.env.PANEL_TOKEN = 'panel-token-that-must-not-leak';

    runner = new LocaltonetRunner(state, {
      binaryCommand: clientPath,
      dataDirectory,
      pollIntervalMs: 30_000,
      fetchImpl: async (input, init) => {
        assert.match(String(input), /\/api\/v2\/auth-tokens\/auth-token-that-must-not-persist\/tunnels$/);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer api-key-that-must-not-persist');
        return new Response(JSON.stringify([{
          protocolType: 2,
          clientPort: 19132,
          url: 'bedrock.example.net:30001',
          connectionStatus: true,
        }]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const addressDetected = waitForLocaltonetAddress(state);
    runner.startOnce();
    await addressDetected;

    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      args: string[];
      token: string;
      tokenMode: number;
      authEnv: string | null;
      apiEnv: string | null;
      panelToken: string | null;
    };
    assert.deepEqual(receipt.args.slice(0, 1), ['--headless']);
    assert.ok(receipt.args.includes('--authtoken-file'));
    assert.equal(receipt.token, 'auth-token-that-must-not-persist');
    assert.equal(receipt.tokenMode, 0o600);
    assert.equal(receipt.authEnv, null);
    assert.equal(receipt.apiEnv, null);
    assert.equal(receipt.panelToken, null);

    await runner.shutdown();
    await state.flush();
    assert.equal(state.getSnapshot().localtonet.status, 'running');
    assert.equal(state.getSnapshot().localtonet.address, 'bedrock.example.net:30001');
    assert.equal(state.getSnapshot().localtonet.error, null);
    assert.equal(JSON.stringify(state.getSnapshot()).includes('auth-token-that-must-not-persist'), false);
    assert.equal(JSON.stringify(state.getSnapshot()).includes('api-key-that-must-not-persist'), false);
    const persistedState = await readFile(state.filePath, 'utf8');
    assert.equal(persistedState.includes('auth-token-that-must-not-persist'), false);
    assert.equal(persistedState.includes('api-key-that-must-not-persist'), false);

    const tokenFile = receipt.args[receipt.args.indexOf('--authtoken-file') + 1];
    await assert.rejects(access(tokenFile), 'temporary AuthToken file should be removed on shutdown');
  } finally {
    restoreEnvironment();
    await runner?.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
