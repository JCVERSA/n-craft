import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parsePlayerLifecycleMessage } from '../src/bedrock/playerTracker.ts';
import {
  parseLinuxProcessCpuTicks,
  parseLinuxResidentMemoryBytes,
} from '../src/bedrock/processMetrics.ts';
import { BedrockRestartScheduler, computeNextScheduledRestart } from '../src/bedrock/scheduler.ts';
import type { BedrockConsole } from '../src/bedrock/console.ts';
import type { DeployPipeline } from '../src/bedrock/deployPipeline.ts';
import { StateStore } from '../src/state.ts';

test('player lifecycle parser tracks XUIDs without retaining player names in state', () => {
  assert.deepEqual(
    parsePlayerLifecycleMessage('[INFO] Player connected: PlayerOne, xuid: 2535412345678901'),
    { action: 'connected', playerKey: 'xuid:2535412345678901' },
  );
  assert.deepEqual(
    parsePlayerLifecycleMessage('Player disconnected: PlayerOne, xuid: 2535412345678901'),
    { action: 'disconnected', playerKey: 'xuid:2535412345678901' },
  );
  assert.deepEqual(parsePlayerLifecycleMessage('Player connected: Player Two'), {
    action: 'connected',
    playerKey: 'name:player two',
  });
  assert.equal(parsePlayerLifecycleMessage('Server started'), null);
});

test('Linux process metric parsers handle process names with spaces and resident memory', () => {
  assert.equal(parseLinuxProcessCpuTicks('123 (bedrock server (1)) S 1 2 3 4 5 6 7 8 9 10 110 12 13'), 122);
  assert.equal(parseLinuxProcessCpuTicks('malformed process stat'), null);
  assert.equal(parseLinuxResidentMemoryBytes('Name:\tbedrock_server\nVmRSS:\t1234 kB\n'), 1_263_616);
  assert.equal(parseLinuxResidentMemoryBytes('Name:\tbedrock_server\n'), null);
});

test('daily restart calculation uses Africa/Douala wall clock and rolls to tomorrow after 04:00', () => {
  const beforeFourLocal = new Date('2026-09-27T02:30:00.000Z'); // 03:30 in Bafoussam.
  assert.equal(
    computeNextScheduledRestart(beforeFourLocal, '04:00', 'Africa/Douala').toISOString(),
    '2026-09-27T03:00:00.000Z',
  );

  const atFourLocal = new Date('2026-09-27T03:00:00.000Z');
  assert.equal(
    computeNextScheduledRestart(atFourLocal, '04:00', 'Africa/Douala').toISOString(),
    '2026-09-28T03:00:00.000Z',
  );
});

test('restart calculation rejects an invalid time zone or clock time', () => {
  assert.throws(() => computeNextScheduledRestart(new Date(), '25:90', 'Africa/Douala'), /Heure/);
  assert.throws(() => computeNextScheduledRestart(new Date(), '04:00', 'Mars/Olympus'), RangeError);
});

test('scheduled restart sends an in-game warning and restarts at the scheduled instant', async () => {
  const commands: string[] = [];
  let restartCalls = 0;
  const fakeState = {
    getSnapshot: () => ({ server: { status: 'running', error: null } }),
  } as unknown as StateStore;
  const fakeConsole = {
    isReady: true,
    sendCommand: (command: string) => { commands.push(command); return true; },
  } as unknown as BedrockConsole;
  const fakePipeline = {
    isRunning: false,
    restartExisting: async () => { restartCalls += 1; },
  } as unknown as DeployPipeline;
  const scheduler = new BedrockRestartScheduler(fakeState, fakeConsole, fakePipeline, {
    BDS_RESTART_ENABLED: 'true',
    BDS_RESTART_TIME: '04:00',
    BDS_RESTART_TIMEZONE: 'Africa/Douala',
    BDS_RESTART_WARNING_MINUTES: '5',
  });
  const runScheduledRestart = (scheduler as unknown as {
    runScheduledRestart: (at: Date) => Promise<void>;
  }).runScheduledRestart.bind(scheduler);

  await runScheduledRestart(new Date(Date.now() + 300));

  assert.equal(restartCalls, 1);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /say \[Nebula Craft\] Redémarrage quotidien dans/);
  assert.equal(scheduler.getSnapshot().phase, 'idle');
  assert.equal(scheduler.getSnapshot().countdownSeconds, null);
  await scheduler.shutdown();
});

test('StateStore.updateServerMetrics broadcasts volatile metrics in memory without rewriting state.json', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-volatile-metrics-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.initialize();
  await store.updateServer({ status: 'running', pid: 4242 });

  const stateFilePath = path.join(root, 'state.json');
  const diskBefore = await readFile(stateFilePath, 'utf8');
  const mtimeBefore = (await stat(stateFilePath)).mtimeMs;

  let changeCount = 0;
  store.on('change', () => {
    changeCount += 1;
  });

  store.updateServerMetrics({
    cpuPercent: 37.5,
    memoryBytes: 512 * 1024 * 1024,
    metricsUpdatedAt: '2026-11-01T12:00:00.000Z',
  });

  const snapshot = store.getSnapshot();
  assert.equal(changeCount, 1);
  assert.equal(snapshot.server.cpuPercent, 37.5);
  assert.equal(snapshot.server.memoryBytes, 512 * 1024 * 1024);
  assert.equal(snapshot.server.metricsUpdatedAt, '2026-11-01T12:00:00.000Z');

  const diskAfter = await readFile(stateFilePath, 'utf8');
  const mtimeAfter = (await stat(stateFilePath)).mtimeMs;
  assert.equal(diskAfter, diskBefore);
  assert.equal(mtimeAfter, mtimeBefore);
});

