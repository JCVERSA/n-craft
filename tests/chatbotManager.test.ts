import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BedrockChatbotManager } from '../src/bedrock/chatbot/manager.ts';
import { ChatbotAuthCacheStore } from '../src/bedrock/chatbot/authCache.ts';
import { BedrockConsole } from '../src/bedrock/console.ts';
import { StateStore } from '../src/state.ts';
import type { DeployConfiguration, VersionEntry } from '../src/types/backend.ts';

const VERSION: VersionEntry = {
  version: '1.21.130.3',
  clientVersion: '1.21.130',
  channel: 'stable',
  label: 'Bedrock 1.21.130.3',
  downloadUrl: 'https://example.invalid/test.zip',
  releaseDate: null,
};
const DEVICE_RESPONSE = {
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://www.microsoft.com/link',
  expires_in: 600,
};

type FakeDeviceCode = { user_code: string; verification_uri: string; expires_in: number };

class FakeBedrockClient extends EventEmitter {
  username = 'N-Craft assistant';
  profile?: { name?: string; xuid?: string | number };
  options: { protocolVersion?: number; version?: string };

  constructor(
    private readonly authFlow: {
      msa: { authDeviceCode(callback: (data: FakeDeviceCode) => void): Promise<unknown> };
    },
    options: Record<string, unknown>,
  ) {
    super();
    this.options = options as { protocolVersion?: number; version?: string };
  }

  init(): void {
    this.emit('connect_allowed');
  }

  connect(): void {
    void this.authFlow.msa.authDeviceCode((data) => this.emit('device_code', data))
      .then((data) => this.emit('authenticated', data))
      .catch((error: Error) => this.emit('error', error));
  }

  queue(): void {}
  disconnect(): void { this.emit('close'); }
  close(): void { this.emit('close'); }
}

async function createHarness(t: test.TestContext, linked = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-chatbot-manager-'));
  const dataDirectory = path.join(root, 'data');
  const serverDirectory = path.join(root, 'server');
  const state = new StateStore(dataDirectory);
  await state.initialize();
  await state.setActiveConfig({ version: VERSION.version } as DeployConfiguration);
  await state.updateServer({ status: 'running', pid: 1234, startedAt: new Date().toISOString() });

  if (linked) {
    const cache = new ChatbotAuthCacheStore(path.join(dataDirectory, 'bedrock-chatbot'));
    await cache.initialize();
    await cache.markLinked();
  }

  let deviceCodeRequests = 0;
  let latestClient: FakeBedrockClient | null = null;
  let managerCallback: ((data: FakeDeviceCode) => void) | null = null;
  const manager = new BedrockChatbotManager({
    dataDirectory,
    serverDirectory,
    bedrockConsole: { isReady: true } as BedrockConsole,
    state,
    findVersion: (version) => version === VERSION.version ? VERSION : undefined,
    environment: { GEMINI_API_KEY: 'test-only-fake-key', CHATBOT_DAILY_LIMIT: '5' },
    authFlowFactory: (_username, _cache, _options, callback) => {
      managerCallback = callback;
      return {
        msa: {
          verifyTokens: async () => false,
          getAccessToken: async () => undefined,
          authDeviceCode: async (onDeviceCode) => {
            deviceCodeRequests += 1;
            onDeviceCode(DEVICE_RESPONSE);
            return { accessToken: 'test-only-fake-access-token' };
          },
        },
      };
    },
    clientFactory: (options) => {
      const authFlow = options.authflow as {
        msa: { authDeviceCode(callback: (data: FakeDeviceCode) => void): Promise<unknown> };
      };
      const client = new FakeBedrockClient(authFlow, options);
      client.on('device_code', (data) => managerCallback?.(data as FakeDeviceCode));
      latestClient = client;
      return client;
    },
  });

  await manager.initialize();
  t.after(async () => {
    await manager.shutdown();
    await state.flush();
    await rm(root, { recursive: true, force: true });
  });

  return {
    manager,
    state,
    dataDirectory,
    serverDirectory,
    get deviceCodeRequests() { return deviceCodeRequests; },
    get latestClient() { return latestClient; },
  };
}

test('an unlinked account never starts a client or Microsoft device flow automatically', async (t) => {
  const harness = await createHarness(t);
  await harness.manager.syncState(harness.state.getSnapshot());
  assert.equal(harness.latestClient, null);
  assert.equal(harness.deviceCodeRequests, 0);
  assert.equal(harness.manager.getSnapshot().status, 'not_linked');
  assert.equal(harness.manager.getSnapshot().userActionPending, false);
});

test('Microsoft device authorization begins only after an explicit link and can be cancelled', async (t) => {
  const harness = await createHarness(t);
  assert.equal(harness.deviceCodeRequests, 0);

  await harness.manager.startUserApprovedLink();
  assert.equal(harness.deviceCodeRequests, 1);
  assert.equal(harness.manager.getSnapshot().status, 'awaiting_approval');
  assert.equal(harness.manager.getSnapshot().userActionPending, true);
  assert.deepEqual(harness.manager.getSnapshot().deviceCode, {
    verificationUrl: DEVICE_RESPONSE.verification_uri,
    userCode: DEVICE_RESPONSE.user_code,
    expiresAt: harness.manager.getSnapshot().deviceCode?.expiresAt,
  });
  assert.ok(Math.abs(Date.parse(harness.manager.getSnapshot().deviceCode!.expiresAt) - Date.now() - 600_000) < 100);
  await harness.state.flush();
  assert.equal((await readFile(harness.state.filePath, 'utf8')).includes(DEVICE_RESPONSE.user_code), false);

  await harness.manager.cancelUserApprovedLink();
  assert.equal(harness.manager.getSnapshot().status, 'not_linked');
  assert.equal(harness.manager.getSnapshot().deviceCode, null);
  assert.equal(harness.manager.getSnapshot().userActionPending, false);
});

test('operator profiles are refused and their OAuth cache is erased', async (t) => {
  const harness = await createHarness(t);
  const privateCache = new ChatbotAuthCacheStore(path.join(harness.dataDirectory, 'bedrock-chatbot'));
  await privateCache.initialize();
  privateCache.setWritesAllowed(true);
  await privateCache.factory({ cacheName: 'live', username: 'ncraft-bedrock-chatbot' }).setCached({ testToken: 'fake-token' });
  await mkdir(harness.serverDirectory, { recursive: true });
  await writeFile(path.join(harness.serverDirectory, 'permissions.json'), JSON.stringify([
    { permission: 'operator', xuid: '1234567890123456' },
  ]));
  await harness.manager.startUserApprovedLink();
  const client = harness.latestClient!;
  client.profile = { name: 'TestAccount', xuid: '1234567890123456' };
  client.emit('spawn');

  for (let attempt = 0; attempt < 20 && harness.manager.getSnapshot().status !== 'account_operator'; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(harness.manager.getSnapshot().status, 'account_operator');
  assert.equal(harness.manager.getSnapshot().accountLinked, false);
  assert.equal(harness.manager.getSnapshot().occupiesPlayerSlot, false);
  assert.equal(harness.manager.getSnapshot().deviceCode, null);
  await assert.rejects(readFile(path.join(harness.dataDirectory, 'bedrock-chatbot', 'auth', 'live-cache.json')));
});

test('a linked profile may reconnect silently but never requests a new device code', async (t) => {
  const harness = await createHarness(t, true);
  await harness.manager.syncState(harness.state.getSnapshot());
  for (let attempt = 0; attempt < 20 && harness.manager.getSnapshot().status !== 'reauth_required'; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(harness.latestClient !== null, true);
  assert.equal(harness.deviceCodeRequests, 0);
  assert.equal(harness.manager.getSnapshot().status, 'reauth_required');
  assert.equal(harness.manager.getSnapshot().accountLinked, true);
});
