import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BedrockConsole } from '../src/bedrock/console.ts';
import { DeployPipeline } from '../src/bedrock/deployPipeline.ts';
import { StateStore } from '../src/state.ts';
import type { SystemPreflight } from '../src/types/backend.ts';
import type { DeployConfiguration } from '../src/types/backend.ts';

const configuration: DeployConfiguration = {
  version: '1.19.50.02',
  serverName: 'Test Server',
  levelName: 'PreservedWorld',
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 8,
  adminXuids: ['1234567890123456'],
  seed: '',
  viewDistance: 8,
  allowCheats: false,
  eulaAccepted: true,
};

const preflight: SystemPreflight = {
  checkedAt: new Date().toISOString(),
  platform: 'linux',
  arch: 'x64',
  nodeVersion: 'v22.12.0',
  glibcVersion: '2.36',
  glibc: { ok: true, detail: 'ok' },
  libcurl: { ok: true, detail: 'ok' },
  memoryLimitBytes: 2 * 1024 ** 3,
  memoryRequirementBytes: 4 * 1024 ** 3,
  memoryWarning: true,
  diskFreeBytes: 10 * 1024 ** 3,
  dataDiskFreeBytes: 10 * 1024 ** 3,
  serverDiskFreeBytes: 10 * 1024 ** 3,
  dataDiskRequiredBytes: 2 * 1024 ** 3,
  serverDiskRequiredBytes: 0,
  sharedDiskVolume: true,
  diskWarning: false,
  playitBinary: { ok: true, detail: 'daemon' },
  playitCliBinary: { ok: true, detail: 'cli' },
  bedrockBinary: { ok: true, detail: 'ready' },
  deployReady: true,
  warnings: ['low-memory warning is informational'],
};

async function waitForServerStatus(state: StateStore, status: string): Promise<void> {
  if (state.getSnapshot().server.status === status) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.removeListener('change', onChange);
      reject(new Error(`Timed out waiting for server status ${status}.`));
    }, 5000);
    const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
      if (snapshot.server.status !== status) return;
      clearTimeout(timer);
      state.removeListener('change', onChange);
      resolve();
    };
    state.on('change', onChange);
  });
}

test('startExisting launches the deployed binary without deleting its world or configuration', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Bedrock child-process test uses a Linux executable script.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-start-existing-'));
  const dataDirectory = path.join(directory, 'data');
  const serverDirectory = path.join(directory, 'bedrock', 'server');
  const sentinelPath = path.join(serverDirectory, 'world', 'level.dat');
  const binaryPath = path.join(serverDirectory, 'bedrock_server');
  const bedrockConsole = new BedrockConsole(dataDirectory);
  try {
    await mkdir(path.dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, 'existing world bytes', 'utf8');
    await writeFile(binaryPath, '#!/bin/sh\nprintf "Server started\\n"\nwhile IFS= read -r line; do [ "$line" = "stop" ] && exit 0; done\n', { encoding: 'utf8', mode: 0o755 });

    const state = new StateStore(dataDirectory);
    await state.initialize();
    await state.setActiveConfig(configuration);
    const inspector = { inspect: async () => preflight } as unknown as ConstructorParameters<typeof DeployPipeline>[2];
    const pipeline = new DeployPipeline(state, bedrockConsole, inspector, dataDirectory, serverDirectory, () => undefined);

    const started = waitForServerStatus(state, 'running');
    pipeline.startExisting();
    await started;
    const operationDeadline = Date.now() + 5000;
    while (pipeline.isRunning && Date.now() < operationDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await readFile(sentinelPath, 'utf8'), 'existing world bytes');
    assert.equal((await readFile(binaryPath, 'utf8')).includes('Server started'), true);
    assert.equal(state.getSnapshot().server.status, 'running');
    assert.equal(pipeline.isRunning, false, 'the asynchronous startup operation completes while Bedrock remains alive');

    await pipeline.stop();
    assert.equal(state.getSnapshot().server.status, 'stopped');
    assert.equal(await readFile(sentinelPath, 'utf8'), 'existing world bytes');
  } finally {
    await bedrockConsole.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
