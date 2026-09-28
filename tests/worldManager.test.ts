import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type { DeployConfiguration } from '../src/types/backend.ts';
import { extractZipSafely } from '../src/bedrock/extractArchive.ts';
import { WorldManager, WorldManagerError } from '../src/bedrock/worldManager.ts';

const VERSION_A = '1.21.131.1';
const VERSION_B = '1.20.81.01';

function configuration(version = VERSION_A, seed = 'seed-123'): DeployConfiguration {
  return {
    version,
    serverName: 'N-Craft test',
    levelName: 'Draft name',
    gamemode: 'survival',
    difficulty: 'normal',
    maxPlayers: 10,
    adminXuids: ['2535412894129841'],
    seed,
    viewDistance: 10,
    allowCheats: false,
    eulaAccepted: true,
  };
}

async function setupManager(): Promise<{ root: string; manager: WorldManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-world-manager-'));
  const manager = new WorldManager(path.join(root, 'data'), path.join(root, 'bedrock', 'server'));
  await manager.initialize(null);
  return { root, manager };
}

async function materializeWorld(manager: WorldManager, folder: string): Promise<string> {
  const directory = path.join(manager.worldsDirectory, folder);
  await mkdir(path.join(directory, 'db'), { recursive: true });
  await writeFile(path.join(directory, 'level.dat'), 'leveldata');
  await writeFile(path.join(directory, 'db', 'CURRENT'), 'MANIFEST-000001\n');
  return directory;
}

async function writeZip(zipPath: string, entries: Array<{ name: string; value: string }>): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = createWriteStream(zipPath, { flags: 'wx', mode: 0o600 });
  const writing = pipeline(zip.outputStream, output);
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.value), entry.name);
  zip.end();
  await writing;
}

test('creates isolated pending worlds and only resumes a ready world on its exact BDS version', async (context) => {
  const { root, manager } = await setupManager();
  context.after(() => rm(root, { recursive: true, force: true }));

  const first = await manager.resolveForDeployment(configuration(), { mode: 'new', name: 'My Survival World' });
  assert.notEqual(first.configuration.levelName, 'My Survival World');
  assert.match(first.configuration.levelName, /^ncraft_[0-9a-f]{24}$/);
  assert.equal((await manager.listWorlds())[0]?.status, 'pending');

  await materializeWorld(manager, first.configuration.levelName);
  assert.equal((await manager.listWorlds())[0]?.status, 'ready');

  const resumed = await manager.resolveForDeployment(configuration(), { mode: 'existing', id: first.worldId });
  assert.equal(resumed.configuration.levelName, first.configuration.levelName);
  assert.equal(resumed.configuration.seed, 'seed-123');
  assert.equal(resumed.worldId, first.worldId);

  await assert.rejects(
    manager.resolveForDeployment(configuration(VERSION_B, 'seed-123'), { mode: 'existing', id: first.worldId }),
    (error: unknown) => error instanceof WorldManagerError && /autre version BDS/.test(error.message),
  );
  await assert.rejects(
    manager.resolveForDeployment(configuration(VERSION_A, 'different-seed'), { mode: 'existing', id: first.worldId }),
    (error: unknown) => error instanceof WorldManagerError && /seed.*ne peut pas être modifiée/i.test(error.message),
  );

  const second = await manager.resolveForDeployment(configuration(VERSION_B, 'seed-123'), { mode: 'new', name: 'My Survival World' });
  assert.notEqual(second.configuration.levelName, first.configuration.levelName);
  assert.equal((await manager.listWorlds()).length, 2);
});

test('adopts the active legacy configuration without allowing one folder to be reused by another version', async (context) => {
  const { root, manager } = await setupManager();
  context.after(() => rm(root, { recursive: true, force: true }));
  const active = { ...configuration(), levelName: 'ActiveLegacyWorld' };

  await manager.ensureActiveWorld(active);
  const [pending] = await manager.listWorlds();
  assert.equal(pending?.folder, 'ActiveLegacyWorld');
  assert.equal(pending?.version, VERSION_A);
  assert.equal(pending?.status, 'pending');

  await materializeWorld(manager, 'ActiveLegacyWorld');
  await manager.ensureActiveWorld(active);
  assert.equal((await manager.listWorlds())[0]?.status, 'ready');
  await assert.rejects(
    manager.ensureActiveWorld({ ...active, version: VERSION_B }),
    (error: unknown) => error instanceof WorldManagerError && /déjà dédié à une autre version/.test(error.message),
  );
});

test('imports .mcworld-compatible archives without overwrite and exports a safe round trip', async (context) => {
  const { root, manager } = await setupManager();
  context.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'source.mcworld');
  await writeZip(archivePath, [
    { name: 'level.dat', value: 'original level' },
    { name: 'db/CURRENT', value: 'MANIFEST-000001\n' },
    { name: 'db/MANIFEST-000001', value: 'manifest bytes' },
  ]);

  const imported = await manager.importArchive(archivePath, 'Imported world', VERSION_A, null);
  assert.equal(imported.status, 'ready');
  assert.equal(imported.version, VERSION_A);
  assert.equal(imported.seed, null);
  assert.equal(await readFile(path.join(manager.worldsDirectory, imported.folder, 'level.dat'), 'utf8'), 'original level');
  await assert.rejects(manager.importArchive(archivePath, 'Imported world', VERSION_A, null), /already|existe déjà/i);
  assert.equal((await manager.listWorlds()).length, 1);

  const exportedPath = path.join(root, 'export.mcworld');
  const exported = await manager.createWorldArchive(imported.id);
  assert.equal(manager.isBusy, true, 'the export holds a lock against a concurrent Bedrock start');
  await pipeline(exported.stream, createWriteStream(exportedPath, { flags: 'wx', mode: 0o600 }));
  assert.equal(manager.isBusy, false);
  assert.match(exported.fileName, /\.mcworld$/);

  const extracted = path.join(root, 'round-trip');
  await extractZipSafely(exportedPath, extracted);
  assert.equal(await readFile(path.join(extracted, 'level.dat'), 'utf8'), 'original level');
  assert.equal(await readFile(path.join(extracted, 'db', 'MANIFEST-000001'), 'utf8'), 'manifest bytes');
});

test('requires exact-name confirmation and refuses to delete a world containing symlinks', async (context) => {
  const { root, manager } = await setupManager();
  context.after(() => rm(root, { recursive: true, force: true }));

  const created = await manager.resolveForDeployment(configuration(), { mode: 'new', name: 'Delete me' });
  const directory = await materializeWorld(manager, created.configuration.levelName);
  const external = path.join(root, 'outside.txt');
  await writeFile(external, 'keep outside');
  await import('node:fs/promises').then(({ symlink }) => symlink(external, path.join(directory, 'external-link')));

  await assert.rejects(
    manager.deleteWorld(created.worldId, 'wrong name'),
    (error: unknown) => error instanceof WorldManagerError && /Confirmation refusée/.test(error.message),
  );
  assert.equal(await readFile(external, 'utf8'), 'keep outside');
  await assert.rejects(
    manager.deleteWorld(created.worldId, 'Delete me'),
    (error: unknown) => error instanceof WorldManagerError && /lien symbolique/.test(error.message),
  );
  assert.equal(await lstat(directory).then((info) => info.isDirectory()), true);
  assert.equal(await readFile(external, 'utf8'), 'keep outside');

  await rm(path.join(directory, 'external-link'));
  await manager.deleteWorld(created.worldId, 'Delete me');
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  assert.equal((await manager.listWorlds()).length, 0);
});

test('registers legacy worlds by exact active configuration and leaves other worlds unassigned', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-world-legacy-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, 'bedrock', 'server');
  const worldsDirectory = path.join(serverDirectory, 'worlds');
  await mkdir(path.join(worldsDirectory, 'ActiveFolder', 'db'), { recursive: true });
  await mkdir(path.join(worldsDirectory, 'OldFolder', 'db'), { recursive: true });
  await writeFile(path.join(worldsDirectory, 'ActiveFolder', 'level.dat'), 'active');
  await writeFile(path.join(worldsDirectory, 'OldFolder', 'level.dat'), 'old');
  const manager = new WorldManager(path.join(root, 'data'), serverDirectory);
  await manager.initialize({ ...configuration(), levelName: 'ActiveFolder' });

  const worlds = await manager.listWorlds();
  assert.equal(worlds.find((world) => world.folder === 'ActiveFolder')?.version, VERSION_A);
  assert.equal(worlds.find((world) => world.folder === 'OldFolder')?.version, null);
  assert.equal(worlds.find((world) => world.folder === 'OldFolder')?.status, 'unassigned');
});
