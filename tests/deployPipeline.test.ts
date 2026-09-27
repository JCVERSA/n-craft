import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeployInProgressError, DeployPipeline } from '../src/bedrock/deployPipeline.ts';
import { StateStore } from '../src/state.ts';
import type { SystemPreflight } from '../src/types/backend.ts';

const configuration = {
  version: '1.19.50.02',
  serverName: 'test',
  levelName: 'world',
  gamemode: 'survival' as const,
  difficulty: 'normal' as const,
  maxPlayers: 4,
  adminXuids: ['1234567890123456'],
  seed: '',
  viewDistance: 10,
  allowCheats: false,
  eulaAccepted: true,
};

function preflight(deployReady: boolean): SystemPreflight {
  return {
    checkedAt: new Date().toISOString(),
    platform: 'linux',
    arch: 'x64',
    nodeVersion: 'v22',
    glibcVersion: '2.36',
    glibc: { ok: true, detail: 'test' },
    libcurl: { ok: deployReady, detail: deployReady ? 'test' : 'missing for test' },
    memoryLimitBytes: 2 * 1024 ** 3,
    memoryRequirementBytes: 4 * 1024 ** 3,
    memoryWarning: true,
    diskFreeBytes: 8 * 1024 ** 3,
    dataDiskFreeBytes: 8 * 1024 ** 3,
    serverDiskFreeBytes: 8 * 1024 ** 3,
    dataDiskRequiredBytes: 6 * 1024 ** 3,
    serverDiskRequiredBytes: 0,
    sharedDiskVolume: true,
    diskWarning: false,
    playitBinary: { ok: false, detail: 'missing' },
    playitCliBinary: { ok: false, detail: 'missing' },
    localtonetBinary: { ok: false, detail: 'missing' },
    bedrockBinary: { ok: false, detail: 'not deployed' },
    deployReady,
    warnings: [],
  };
}

test('rejects concurrent deploy calls in process', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-deploy-lock-'));
  try {
    const dataDirectory = path.join(directory, 'data');
    const serverDirectory = path.join(directory, 'bedrock', 'server');
    const state = new StateStore(dataDirectory);
    await state.initialize();

    let releasePreflight!: (value: SystemPreflight) => void;
    const preflightPromise = new Promise<SystemPreflight>((resolve) => { releasePreflight = resolve; });
    const inspector = { inspect: async () => preflightPromise } as unknown as ConstructorParameters<typeof DeployPipeline>[2];
    const fakeConsole = Object.assign(new EventEmitter(), {
      isRunning: false,
      pid: null,
      stop: async () => undefined,
      start: async () => undefined,
    }) as unknown as ConstructorParameters<typeof DeployPipeline>[1];
    const pipeline = new DeployPipeline(
      state,
      fakeConsole,
      inspector,
      dataDirectory,
      serverDirectory,
      () => undefined,
    );

    const preflightStarted = new Promise<void>((resolve) => {
      const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
        if (snapshot.pipeline.step !== 'preflight') return;
        state.removeListener('change', onChange);
        resolve();
      };
      state.on('change', onChange);
    });
    pipeline.start(configuration);
    assert.throws(() => pipeline.start(configuration), DeployInProgressError);
    await preflightStarted;

    const pipelineFailed = new Promise<void>((resolve) => {
      const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
        if (snapshot.pipeline.status !== 'failed') return;
        state.removeListener('change', onChange);
        resolve();
      };
      state.on('change', onChange);
    });
    releasePreflight(preflight(false));

    await pipelineFailed;
    await new Promise<void>((resolve) => {
      const waitForPipeline = () => pipeline.isRunning ? setImmediate(waitForPipeline) : resolve();
      waitForPipeline();
    });
    await state.flush();
    assert.equal(state.getSnapshot().pipeline.status, 'failed');
    assert.equal(state.getSnapshot().server.status, 'stopped');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('a failed Bedrock stop prevents Wipe and reports the still-running process', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-deploy-stop-failure-'));
  try {
    const dataDirectory = path.join(directory, 'data');
    const serverDirectory = path.join(directory, 'bedrock', 'server');
    await mkdir(serverDirectory, { recursive: true });
    const sentinelPath = path.join(serverDirectory, 'preserve-me.txt');
    await writeFile(sentinelPath, 'old world', 'utf8');

    const state = new StateStore(dataDirectory);
    await state.initialize();
    const inspector = { inspect: async () => preflight(true) } as unknown as ConstructorParameters<typeof DeployPipeline>[2];
    let stopCalls = 0;
    const fakeConsole = Object.assign(new EventEmitter(), {
      isRunning: true,
      pid: 4321,
      stop: async () => { stopCalls += 1; throw new Error('process did not exit'); },
      start: async () => { throw new Error('must not start'); },
    }) as unknown as ConstructorParameters<typeof DeployPipeline>[1];
    const pipeline = new DeployPipeline(state, fakeConsole, inspector, dataDirectory, serverDirectory, () => undefined);
    const pipelineFailed = new Promise<void>((resolve) => {
      const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
        if (snapshot.pipeline.status !== 'failed') return;
        state.removeListener('change', onChange);
        resolve();
      };
      state.on('change', onChange);
    });

    pipeline.start(configuration);
    await pipelineFailed;
    await new Promise<void>((resolve) => {
      const waitForPipeline = () => pipeline.isRunning ? setImmediate(waitForPipeline) : resolve();
      waitForPipeline();
    });
    await state.flush();

    assert.equal(await readFile(sentinelPath, 'utf8'), 'old world');
    assert.equal(stopCalls, 1);
    assert.equal(state.getSnapshot().server.status, 'failed');
    assert.match(state.getSnapshot().server.error ?? '', /process did not exit/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('shutdown cancels an in-flight preflight and never wipes or starts Bedrock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-deploy-shutdown-'));
  try {
    const dataDirectory = path.join(directory, 'data');
    const serverDirectory = path.join(directory, 'bedrock', 'server');
    await mkdir(serverDirectory, { recursive: true });
    const sentinelPath = path.join(serverDirectory, 'preserve-me.txt');
    await writeFile(sentinelPath, 'old data', 'utf8');

    const state = new StateStore(dataDirectory);
    await state.initialize();
    let releasePreflight!: (value: SystemPreflight) => void;
    const preflightPromise = new Promise<SystemPreflight>((resolve) => { releasePreflight = resolve; });
    const inspector = { inspect: async () => preflightPromise } as unknown as ConstructorParameters<typeof DeployPipeline>[2];
    let stopCalls = 0;
    let startCalls = 0;
    const fakeConsole = Object.assign(new EventEmitter(), {
      isRunning: false,
      pid: null,
      stop: async () => { stopCalls += 1; },
      start: async () => { startCalls += 1; },
    }) as unknown as ConstructorParameters<typeof DeployPipeline>[1];
    const pipeline = new DeployPipeline(
      state,
      fakeConsole,
      inspector,
      dataDirectory,
      serverDirectory,
      () => undefined,
    );

    const preflightStarted = new Promise<void>((resolve) => {
      const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
        if (snapshot.pipeline.step !== 'preflight') return;
        state.removeListener('change', onChange);
        resolve();
      };
      state.on('change', onChange);
    });
    pipeline.start(configuration);
    await preflightStarted;

    const shutdown = pipeline.shutdown();
    releasePreflight(preflight(true));
    await shutdown;
    await state.flush();

    assert.equal(await readFile(sentinelPath, 'utf8'), 'old data');
    assert.equal(startCalls, 0);
    assert.equal(stopCalls, 2);
    assert.equal(pipeline.isRunning, false);
    assert.equal(state.getSnapshot().pipeline.status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
