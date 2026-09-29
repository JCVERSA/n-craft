import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SystemInspector } from '../src/preflight.ts';
import type { SystemPreflight } from '../src/types/backend.ts';
import { sanitizedLogLines, sanitizedSamples, sanitizedSystemReport, redactDiagnosticText } from '../src/diagnostics.ts';
import { MonitoringService } from '../src/monitoring.ts';
import { StateStore } from '../src/state.ts';

function systemReport(dataDiskFreeBytes: number, serverDiskFreeBytes: number): SystemPreflight {
  const check = { ok: true, detail: 'ok' };
  return {
    checkedAt: new Date().toISOString(),
    platform: 'linux',
    arch: 'x64',
    nodeVersion: 'v22',
    glibcVersion: '2.39',
    glibc: check,
    libcurl: check,
    legacyOpenSsl: check,
    memoryLimitBytes: null,
    memoryRequirementBytes: 1024,
    memoryWarning: false,
    diskFreeBytes: Math.min(dataDiskFreeBytes, serverDiskFreeBytes),
    dataDiskFreeBytes,
    serverDiskFreeBytes,
    dataDiskRequiredBytes: 1024,
    serverDiskRequiredBytes: 1024,
    sharedDiskVolume: false,
    diskWarning: false,
    portwarpBinary: check,
    localtonetBinary: check,
    playitBinary: check,
    playitCliBinary: check,
    bedrockBinary: check,
    deployReady: true,
    warnings: [],
  };
}

test('collects resource and disk samples, raises threshold alerts, and persists only operational metrics', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-monitoring-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(directory);
  await state.initialize();
  await state.updateServer({
    status: 'running',
    desiredRunning: true,
    cpuPercent: 97.5,
    memoryBytes: 8 * 1024 ** 3,
    playersOnline: 3,
  });
  const inspector = {
    async inspect() { return systemReport(100 * 1024 ** 2, 4 * 1024 ** 3); },
  } as unknown as SystemInspector;
  const monitoring = new MonitoringService(directory, state, inspector);
  await monitoring.initialize();
  await monitoring.collect();

  const snapshot = monitoring.getSnapshot();
  assert.equal(snapshot.samples.length, 1);
  assert.equal(snapshot.samples[0]?.cpuPercent, 97.5);
  assert.equal(snapshot.samples[0]?.memoryBytes, 8 * 1024 ** 3);
  assert.equal(snapshot.samples[0]?.dataDiskFreeBytes, 100 * 1024 ** 2);
  assert.deepEqual(new Set(snapshot.alerts.map((alert) => alert.id)), new Set(['low-disk', 'high-cpu', 'high-memory']));
  assert.ok(snapshot.alerts.every((alert) => typeof alert.since === 'string'));

  await state.updateServer({ status: 'failed', error: 'simulated process exit', desiredRunning: true });
  const updatedInspector = {
    async inspect() { return systemReport(2 * 1024 ** 3, 4 * 1024 ** 3); },
  } as unknown as SystemInspector;
  const failedMonitoring = new MonitoringService(directory, state, updatedInspector);
  await failedMonitoring.initialize();
  await new Promise((resolve) => setTimeout(resolve, 3));
  await failedMonitoring.collect();
  assert.ok(failedMonitoring.getSnapshot().alerts.some((alert) => alert.id === 'server-failed'));
  await failedMonitoring.shutdown();

  const persisted = JSON.parse(await readFile(path.join(directory, 'monitoring.json'), 'utf8')) as { samples: unknown[] };
  assert.equal(persisted.samples.length, 2, 'the sample history survives a second service instance');
  await monitoring.shutdown();
});

test('rejects unsafe alert thresholds without replacing the saved policy', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-monitoring-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(directory);
  await state.initialize();
  const inspector = { async inspect() { return systemReport(1e9, 1e9); } } as unknown as SystemInspector;
  const monitoring = new MonitoringService(directory, state, inspector);
  await monitoring.initialize();
  const before = monitoring.getSnapshot().settings;
  await assert.rejects(monitoring.updateSettings({ lowDiskBytes: 1, highCpuPercent: 90, highMemoryBytes: 1024 ** 3 }), /espace disque/i);
  assert.deepEqual(monitoring.getSnapshot().settings, before);
  await monitoring.shutdown();
});

test('diagnostic export redacts credentials, XUIDs, IPs, paths and player chat', () => {
  const text = redactDiagnosticText('accessToken=access-secret refresh_token: refresh-secret clientSecret="client-secret" GEMINI_API_KEY=api-secret player_xuid=2535412894129841 from 203.0.113.19 at /srv/ncraft/.env');
  for (const secret of ['access-secret', 'refresh-secret', 'client-secret', 'api-secret', '2535412894129841', '203.0.113.19', '/srv/ncraft/.env']) {
    assert.equal(text.includes(secret), false, `${secret} should be redacted`);
  }
  assert.match(text, /\[REDACTED\]/);

  const lines = sanitizedLogLines([
    { id: '1', timestamp: new Date().toISOString(), tag: 'CONSOLE', message: 'password=do-not-export', level: 'info' },
    { id: '2', timestamp: new Date().toISOString(), tag: 'CHAT', message: 'player chat should not export', level: 'info' },
    { id: '3', timestamp: new Date().toISOString(), tag: 'BDS', message: 'Player Alice connected. XUID: 2535412894129841', level: 'info' },
    { id: '4', timestamp: new Date().toISOString(), tag: 'PROCESS', message: 'apiKey=hidden-value', level: 'warn' },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.message.includes('hidden-value'), false);
  assert.equal(sanitizedSamples(Array.from({ length: 300 }, (_, index) => ({
    timestamp: new Date(index * 1000).toISOString(),
    cpuPercent: index,
    memoryBytes: null,
    playersOnline: null,
    dataDiskFreeBytes: null,
    serverDiskFreeBytes: null,
  }))).length, 240);

  const report = systemReport(1e9, 2e9);
  const safeReport = sanitizedSystemReport({ ...report, glibc: { ok: false, detail: 'failed at /opt/private/path with token=hidden' } });
  assert.equal(safeReport.glibc.detail.includes('hidden'), false);
  assert.equal(safeReport.glibc.detail.includes('/opt/private/path'), false);
});
