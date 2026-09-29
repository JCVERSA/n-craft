import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pipeline } from 'node:stream/promises';
import type { DeployConfiguration } from '../src/types/backend.ts';
import { BedrockConsole } from '../src/bedrock/console.ts';
import { extractZipSafely } from '../src/bedrock/extractArchive.ts';
import { BedrockSnapshotManager, parseSaveQueryOutput } from '../src/bedrock/snapshots.ts';
import { StateStore } from '../src/state.ts';
import { WorldManager } from '../src/bedrock/worldManager.ts';

const VERSION = '1.21.131.1';

function configuration(): DeployConfiguration {
  return {
    version: VERSION,
    serverName: 'Snapshot test',
    levelName: 'TestWorld',
    gamemode: 'survival',
    difficulty: 'normal',
    maxPlayers: 10,
    adminXuids: ['2535412894129841'],
    seed: '12345',
    viewDistance: 10,
    allowCheats: false,
    eulaAccepted: true,
  };
}

class FakeBedrockConsole extends EventEmitter {
  isRunning = false;
  isReady = false;
  commands: string[] = [];
  responses: Array<string[] | null> = [];

  sendCommand(command: string): boolean {
    this.commands.push(command);
    return true;
  }

  async waitForCommandOutput(command: string, _complete: (lines: readonly string[]) => boolean): Promise<string[] | null> {
    assert.equal(command, 'save query');
    this.commands.push(command);
    return this.responses.shift() ?? null;
  }
}

async function makeFixture(): Promise<{
  root: string;
  manager: WorldManager;
  state: StateStore;
  worldId: string;
  folder: string;
  worldDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-snapshot-test-'));
  const dataDirectory = path.join(root, 'data');
  const serverDirectory = path.join(root, 'bedrock', 'server');
  const manager = new WorldManager(dataDirectory, serverDirectory);
  await manager.initialize(null);
  const deployed = await manager.resolveForDeployment(configuration(), { mode: 'new', name: 'Snapshot world' });
  const folder = deployed.configuration.levelName;
  const worldDirectory = path.join(manager.worldsDirectory, folder);
  await mkdir(path.join(worldDirectory, 'db'), { recursive: true });
  await writeFile(path.join(worldDirectory, 'level.dat'), 'level-original');
  await writeFile(path.join(worldDirectory, 'db', 'CURRENT'), 'MANIFEST-000001\n');
  const state = new StateStore(dataDirectory);
  await state.initialize();
  await state.setActiveConfig(deployed.configuration);
  return { root, manager, state, worldId: deployed.worldId, folder, worldDirectory };
}

test('parses only Bedrock save-query file lengths and rejects another world path', () => {
  const folder = 'ncraft_123456789012345678901234';
  const files = parseSaveQueryOutput([
    'Data saved. Files are now ready to be copied.',
    `[INFO] worlds/${folder}/level.dat: 123, worlds/${folder}/db/CURRENT: 45`,
  ], folder);
  assert.deepEqual(files, [
    { path: 'level.dat', sizeBytes: 123 },
    { path: 'db/CURRENT', sizeBytes: 45 },
  ]);
  assert.equal(parseSaveQueryOutput(['save is not ready'], folder), null);
  assert.throws(
    () => parseSaveQueryOutput([
      'Data saved. Files are now ready to be copied.',
      'worlds/other-world/level.dat: 10, worlds/other-world/db/CURRENT: 2',
    ], folder),
    /different|différent|hors du dossier/i,
  );
});

test('creates a restorable .mcworld snapshot and backs up the current world before restoring', async (context) => {
  const fixture = await makeFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const consoleProcess = new BedrockConsole(path.join(fixture.root, 'data'));
  const snapshots = new BedrockSnapshotManager(path.join(fixture.root, 'data'), fixture.manager, consoleProcess, fixture.state);
  await snapshots.initialize();
  await snapshots.updateSettings({ ...snapshots.getSnapshot().settings, retentionPerWorld: 1 });

  const original = await snapshots.createSnapshot(fixture.worldId, 'manual');
  assert.equal(original.reason, 'manual');
  assert.ok(original.sizeBytes > 0);
  const originalArchive = await snapshots.getArchive(original.id);
  const archivePath = path.join(fixture.root, 'download.mcworld');
  await pipeline(originalArchive.stream, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
  assert.match(originalArchive.fileName, /\.mcworld$/);
  const extracted = path.join(fixture.root, 'extracted');
  await extractZipSafely(archivePath, extracted);
  assert.equal(await readFile(path.join(extracted, 'level.dat'), 'utf8'), 'level-original');
  assert.equal(await readFile(path.join(extracted, 'db', 'CURRENT'), 'utf8'), 'MANIFEST-000001\n');

  await writeFile(path.join(fixture.worldDirectory, 'level.dat'), 'current-world-before-restore');
  const restored = await snapshots.restoreSnapshot(original.id);
  assert.ok(restored.beforeRestore, 'restore creates a safety snapshot of the pre-restore world');
  assert.equal(await readFile(path.join(fixture.worldDirectory, 'level.dat'), 'utf8'), 'level-original');
  assert.ok(snapshots.listForWorld(fixture.worldId).some((snapshot) => snapshot.id === restored.beforeRestore?.id));

  const beforeArchive = await snapshots.getArchive(restored.beforeRestore!.id);
  const beforePath = path.join(fixture.root, 'before-restore.mcworld');
  await pipeline(beforeArchive.stream, createWriteStream(beforePath, { flags: 'wx', mode: 0o600 }));
  const beforeExtracted = path.join(fixture.root, 'before-extracted');
  await extractZipSafely(beforePath, beforeExtracted);
  assert.equal(await readFile(path.join(beforeExtracted, 'level.dat'), 'utf8'), 'current-world-before-restore');
  await consoleProcess.close();
});

test('online snapshot follows hold → query → exact-length copy → resume, including copy failures', async (context) => {
  const fixture = await makeFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const bedrock = new FakeBedrockConsole();
  bedrock.isRunning = true;
  bedrock.isReady = true;
  await fixture.state.updateServer({ status: 'running', pid: 1234, desiredRunning: true });
  const snapshots = new BedrockSnapshotManager(path.join(fixture.root, 'data'), fixture.manager, bedrock as unknown as BedrockConsole, fixture.state);
  await snapshots.initialize();
  bedrock.responses.push([
    'Data saved. Files are now ready to be copied.',
    `worlds/${fixture.folder}/level.dat: 14, worlds/${fixture.folder}/db/CURRENT: 16`,
  ]);
  const saved = await snapshots.createSnapshot(fixture.worldId);
  assert.equal(saved.reason, 'manual');
  assert.deepEqual(bedrock.commands, ['save hold', 'save query', 'save resume']);

  bedrock.commands = [];
  bedrock.responses.push([
    'Data saved. Files are now ready to be copied.',
    `worlds/${fixture.folder}/level.dat: 999999, worlds/${fixture.folder}/db/CURRENT: 16`,
  ]);
  await assert.rejects(snapshots.createSnapshot(fixture.worldId), /plus court que prévu/i);
  assert.equal(bedrock.commands[0], 'save hold');
  assert.equal(bedrock.commands.at(-1), 'save resume', 'save resume is attempted even when copying fails');
});

test('shutdown waits for an in-flight online snapshot to send save resume', async (context) => {
  const fixture = await makeFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const bedrock = new FakeBedrockConsole();
  bedrock.isRunning = true;
  bedrock.isReady = true;
  await fixture.state.updateServer({ status: 'running', pid: 1234, desiredRunning: true });
  const snapshots = new BedrockSnapshotManager(path.join(fixture.root, 'data'), fixture.manager, bedrock as unknown as BedrockConsole, fixture.state);
  await snapshots.initialize();
  bedrock.responses.push([
    'Data saved. Files are now ready to be copied.',
    `worlds/${fixture.folder}/level.dat: 14, worlds/${fixture.folder}/db/CURRENT: 16`,
  ]);
  const creation = snapshots.createSnapshot(fixture.worldId);
  const shutdown = snapshots.shutdown();
  const result = await creation;
  await shutdown;
  assert.ok(result.id);
  assert.equal(bedrock.commands.at(-1), 'save resume');
});
