import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DeployConfiguration } from '../src/types/backend.ts';
import type { BedrockConsole } from '../src/bedrock/console.ts';
import type { DeployPipeline } from '../src/bedrock/deployPipeline.ts';
import { BedrockRecoveryManager } from '../src/bedrock/recovery.ts';
import { StateStore } from '../src/state.ts';

const TEST_CONFIG: DeployConfiguration = {
  version: '1.21.131.1',
  serverName: 'Recovery test',
  levelName: 'RecoveryWorld',
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 10,
  adminXuids: [],
  seed: '',
  viewDistance: 10,
  allowCheats: false,
  eulaAccepted: true,
};

class FakeBedrockConsole extends EventEmitter {
  isRunning = false;
  isReady = false;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for recovery manager state.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('start-after-panel-restart is opt-in, persisted, and requires a remembered desired-running state', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-recovery-startup-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(directory);
  await state.initialize();
  await state.setActiveConfig(TEST_CONFIG);
  await state.updateServer({ desiredRunning: true });
  const bedrock = new FakeBedrockConsole();
  const pipeline = { isRunning: false, startExisting() { throw new Error('must not start until explicitly triggered'); } } as unknown as DeployPipeline;
  const first = new BedrockRecoveryManager(directory, state, bedrock as unknown as BedrockConsole, pipeline);
  await first.initialize();
  assert.equal(first.getSnapshot().settings.startAfterPanelRestart, false);
  assert.equal(first.getSnapshot().startupPending, false);
  await first.updateSettings({
    restartAfterCrash: true,
    startAfterPanelRestart: true,
    maxAttempts: 3,
    delaySeconds: 1,
  });
  await first.shutdown();

  const restartedState = new StateStore(directory);
  await restartedState.initialize();
  const restartedBedrock = new FakeBedrockConsole();
  const restarted = new BedrockRecoveryManager(directory, restartedState, restartedBedrock as unknown as BedrockConsole, pipeline);
  await restarted.initialize();
  assert.equal(restarted.getSnapshot().startupPending, true);
  assert.equal(restarted.getSnapshot().phase, 'idle');
  await restarted.prepareManualStop();
  assert.equal(restarted.getSnapshot().startupPending, false);
  assert.equal(restartedState.getSnapshot().server.desiredRunning, false);
  await restarted.shutdown();
});

test('a crash restarts with a bounded attempt count and stops after the configured limit', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-recovery-crash-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(directory);
  await state.initialize();
  await state.setActiveConfig(TEST_CONFIG);
  await state.updateServer({ status: 'running', pid: 4567, desiredRunning: true });
  const bedrock = new FakeBedrockConsole();
  const pipelineState = { isRunning: false, starts: 0 };
  const pipeline = {
    get isRunning() { return pipelineState.isRunning; },
    startExisting() {
      pipelineState.starts += 1;
      queueMicrotask(() => {
        void state.updateServer({ status: 'failed', pid: null, desiredRunning: true, error: 'simulated startup failure' });
      });
    },
  } as unknown as DeployPipeline;
  const recovery = new BedrockRecoveryManager(directory, state, bedrock as unknown as BedrockConsole, pipeline);
  await recovery.initialize();
  await recovery.updateSettings({
    restartAfterCrash: true,
    startAfterPanelRestart: false,
    maxAttempts: 1,
    delaySeconds: 1,
  });
  bedrock.emit('exit', { wasReady: true, intentional: false });
  assert.equal(recovery.getSnapshot().phase, 'waiting');
  await waitFor(() => recovery.getSnapshot().phase === 'exhausted');
  assert.equal(pipelineState.starts, 1);
  assert.equal(recovery.getSnapshot().attempts, 1);
  assert.match(recovery.getSnapshot().lastError ?? '', /simulated startup failure/);
  await recovery.shutdown();
});

test('invalid recovery limits are rejected without changing the active settings', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-recovery-validation-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(directory);
  await state.initialize();
  const bedrock = new FakeBedrockConsole();
  const pipeline = { isRunning: false, startExisting() {} } as unknown as DeployPipeline;
  const recovery = new BedrockRecoveryManager(directory, state, bedrock as unknown as BedrockConsole, pipeline);
  await recovery.initialize();
  const before = recovery.getSnapshot().settings;
  await assert.rejects(recovery.updateSettings({
    restartAfterCrash: false,
    startAfterPanelRestart: false,
    maxAttempts: 0,
    delaySeconds: 1,
  }), /limite de reprises/i);
  assert.deepEqual(recovery.getSnapshot().settings, before);
  await recovery.shutdown();
});
