import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import yazl from 'yazl';
import { extractZipSafely } from '../src/bedrock/extractArchive.ts';
import { BedrockPackManager, BedrockPackManagerError } from '../src/bedrock/packManager.ts';
import { WorldManager } from '../src/bedrock/worldManager.ts';
import type { DeployConfiguration } from '../src/types/backend.ts';

const VERSION = '1.21.130.3';
const RESOURCE_UUID = 'c82795ee-b2ec-4323-aa6d-c686984f38ca';
const BEHAVIOR_UUID = 'f88b7e49-9741-41aa-91a4-9a1d401826e3';

function configuration(): DeployConfiguration {
  return {
    version: VERSION,
    serverName: 'Pack manager test',
    levelName: 'Not used',
    gamemode: 'survival',
    difficulty: 'normal',
    maxPlayers: 10,
    adminXuids: [],
    seed: '',
    viewDistance: 10,
    allowCheats: false,
    eulaAccepted: true,
  };
}

async function writeZip(zipPath: string, entries: Array<{ name: string; value: string }>): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = createWriteStream(zipPath, { flags: 'wx', mode: 0o600 });
  const writing = pipeline(zip.outputStream, output);
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.value), entry.name);
  zip.end();
  await writing;
}

async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-pack-manager-'));
  const serverDirectory = path.join(root, 'server');
  const dataDirectory = path.join(root, 'data');
  const worlds = new WorldManager(dataDirectory, serverDirectory);
  await worlds.initialize(null);
  const prepared = await worlds.resolveForDeployment(configuration(), { mode: 'new', name: 'Pack test world' });
  const worldDirectory = path.join(worlds.worldsDirectory, prepared.configuration.levelName);
  await mkdir(path.join(worldDirectory, 'db'), { recursive: true });
  await writeFile(path.join(worldDirectory, 'level.dat'), 'level data');
  await writeFile(path.join(worldDirectory, 'db', 'CURRENT'), 'MANIFEST-000001\n');
  const world = worlds.getWorld(prepared.worldId);
  const packs = new BedrockPackManager(worlds);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worlds, packs, world, worldDirectory, serverDirectory };
}

function packManifest(kind: 'resource' | 'behavior', uuid: string, dependencies: Array<{ uuid: string; version: number[] }> = []) {
  return JSON.stringify({
    format_version: 2,
    header: {
      name: kind === 'resource' ? 'Neon UI pack' : 'Example behavior pack',
      description: 'Pack for a local test.',
      uuid,
      version: [2, 0, 0],
    },
    modules: [{
      type: kind === 'resource' ? 'resources' : 'data',
      uuid: kind === 'resource' ? '953dd6e3-0441-49f4-b53f-27767d415de5' : '09e2a129-a1bd-4ff9-9eb9-f65d0c66da00',
      version: [2, 0, 0],
    }],
    dependencies,
  });
}

async function makePackArchive(
  archivePath: string,
  kind: 'resource' | 'behavior',
  uuid: string,
  dependencies: Array<{ uuid: string; version: number[] }> = [],
): Promise<void> {
  const directory = kind === 'resource' ? 'Neoncraft Uix.mcpack' : 'ExampleBehavior';
  await writeZip(archivePath, [
    { name: `${directory}/manifest.json`, value: packManifest(kind, uuid, dependencies) },
    { name: `${directory}/content.txt`, value: 'safe test content' },
  ]);
}

test('honors configured archive entry and expanded-size limits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-pack-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'small.zip');
  await writeZip(archivePath, [
    { name: 'one.txt', value: '1234' },
    { name: 'two.txt', value: '5678' },
  ]);
  await assert.rejects(
    extractZipSafely(archivePath, path.join(root, 'entry-limit'), undefined, { maxEntries: 1 }),
    /nombre d’entrées excessif/,
  );
  await assert.rejects(
    extractZipSafely(archivePath, path.join(root, 'size-limit'), undefined, { maxUnpackedBytes: 3 }),
    /taille décompressée excessive/,
  );
});

test('imports a single-pack ZIP safely and activates or deactivates it for one world', async (t) => {
  const harness = await setup(t);
  const archivePath = path.join(harness.root, 'n3on.zip');
  await makePackArchive(archivePath, 'resource', RESOURCE_UUID);

  const imported = await harness.packs.importArchive(archivePath);
  assert.deepEqual(imported, {
    uuid: RESOURCE_UUID,
    name: 'Neon UI pack',
    description: 'Pack for a local test.',
    kind: 'resource',
    version: [2, 0, 0],
    dependencies: [],
    active: false,
  });
  const installedPath = path.join(harness.serverDirectory, 'resource_packs', `ncraft-${RESOURCE_UUID}`);
  assert.equal(await readFile(path.join(installedPath, 'content.txt'), 'utf8'), 'safe test content');
  assert.equal((await lstat(installedPath)).isDirectory(), true);

  const secondWorld = await harness.worlds.resolveForDeployment(configuration(), { mode: 'new', name: 'Second pack world' });
  const secondWorldDirectory = path.join(harness.worlds.worldsDirectory, secondWorld.configuration.levelName);
  await mkdir(path.join(secondWorldDirectory, 'db'), { recursive: true });
  await writeFile(path.join(secondWorldDirectory, 'level.dat'), 'second level data');
  await writeFile(path.join(secondWorldDirectory, 'db', 'CURRENT'), 'MANIFEST-000001\n');

  let snapshot = await harness.packs.listForWorld(harness.world.id);
  assert.equal(snapshot.worldId, harness.world.id);
  assert.equal(snapshot.packs.find((pack) => pack.uuid === RESOURCE_UUID)?.active, false);
  assert.equal((await harness.packs.listForWorld(secondWorld.worldId)).packs.find((pack) => pack.uuid === RESOURCE_UUID)?.active, false);

  snapshot = await harness.packs.setActive(harness.world.id, RESOURCE_UUID, true);
  assert.equal(snapshot.packs.find((pack) => pack.uuid === RESOURCE_UUID)?.active, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(harness.worldDirectory, 'world_resource_packs.json'), 'utf8')), [
    { pack_id: RESOURCE_UUID, version: [2, 0, 0] },
  ]);
  assert.equal((await harness.packs.listForWorld(secondWorld.worldId)).packs.find((pack) => pack.uuid === RESOURCE_UUID)?.active, false);

  await harness.packs.setActive(secondWorld.worldId, RESOURCE_UUID, true);
  snapshot = await harness.packs.setActive(harness.world.id, RESOURCE_UUID, false);
  assert.equal(snapshot.packs.find((pack) => pack.uuid === RESOURCE_UUID)?.active, false);
  assert.equal((await harness.packs.listForWorld(secondWorld.worldId)).packs.find((pack) => pack.uuid === RESOURCE_UUID)?.active, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(harness.worldDirectory, 'world_resource_packs.json'), 'utf8')), []);
  assert.equal(await readFile(path.join(installedPath, 'content.txt'), 'utf8'), 'safe test content', 'deactivation keeps pack files installed');
  await harness.packs.setActive(secondWorld.worldId, RESOURCE_UUID, false);
});

test('preserves Script API module dependencies without treating them as installed packs', async (t) => {
  const harness = await setup(t);
  const archivePath = path.join(harness.root, 'script-pack.mcpack');
  const manifest = JSON.parse(packManifest('behavior', BEHAVIOR_UUID)) as {
    modules: Array<Record<string, unknown>>;
    dependencies: unknown[];
  };
  manifest.modules[0]!.type = 'script';
  manifest.dependencies = [{ module_name: '@minecraft/server', version: '1.13.0-beta' }];
  await writeZip(archivePath, [{ name: 'ScriptPack/manifest.json', value: JSON.stringify(manifest) }]);

  const imported = await harness.packs.importArchive(archivePath);
  assert.deepEqual(imported.dependencies, [{ type: 'module', moduleName: '@minecraft/server', version: '1.13.0-beta' }]);
  const snapshot = await harness.packs.setActive(harness.world.id, BEHAVIOR_UUID, true);
  assert.equal(snapshot.packs.find((pack) => pack.uuid === BEHAVIOR_UUID)?.active, true);
});

test('validates dependencies and prevents disabling a pack that an active pack requires', async (t) => {
  const harness = await setup(t);
  const resourceArchive = path.join(harness.root, 'resource.mcpack');
  const behaviorArchive = path.join(harness.root, 'addon.zip');
  await makePackArchive(resourceArchive, 'resource', RESOURCE_UUID);
  await makePackArchive(behaviorArchive, 'behavior', BEHAVIOR_UUID, [{ uuid: RESOURCE_UUID, version: [2, 0, 0] }]);
  await harness.packs.importArchive(resourceArchive);
  await harness.packs.importArchive(behaviorArchive);

  await assert.rejects(
    harness.packs.setActive(harness.world.id, BEHAVIOR_UUID, true),
    (error: unknown) => error instanceof BedrockPackManagerError && /Active d’abord/.test(error.message),
  );
  await harness.packs.setActive(harness.world.id, RESOURCE_UUID, true);
  await harness.packs.setActive(harness.world.id, BEHAVIOR_UUID, true);
  await assert.rejects(
    harness.packs.setActive(harness.world.id, RESOURCE_UUID, false),
    (error: unknown) => error instanceof BedrockPackManagerError && /Désactive d’abord/.test(error.message),
  );
  const finalState = await harness.packs.setActive(harness.world.id, BEHAVIOR_UUID, false);
  assert.equal(finalState.packs.find((pack) => pack.uuid === BEHAVIOR_UUID)?.active, false);
  await harness.packs.setActive(harness.world.id, RESOURCE_UUID, false);
});

test('rejects multi-pack archives, invalid manifests, duplicate UUIDs and ZIP traversal', async (t) => {
  const harness = await setup(t);
  const multiple = path.join(harness.root, 'multiple.mcaddon');
  await writeZip(multiple, [
    { name: 'resource/manifest.json', value: packManifest('resource', RESOURCE_UUID) },
    { name: 'behavior/manifest.json', value: packManifest('behavior', BEHAVIOR_UUID) },
  ]);
  await assert.rejects(
    harness.packs.importArchive(multiple),
    (error: unknown) => error instanceof BedrockPackManagerError && /plusieurs packs/.test(error.message),
  );

  const invalid = path.join(harness.root, 'invalid.mcpack');
  await writeZip(invalid, [{ name: 'manifest.json', value: '{not json' }]);
  await assert.rejects(harness.packs.importArchive(invalid), /manifest\.json/);

  const valid = path.join(harness.root, 'valid.mcpack');
  await makePackArchive(valid, 'resource', RESOURCE_UUID);
  await harness.packs.importArchive(valid);
  await assert.rejects(
    harness.packs.importArchive(valid),
    (error: unknown) => error instanceof BedrockPackManagerError && /déjà installé/.test(error.message),
  );
  if (process.platform !== 'win32') {
    const archiveSymlink = path.join(harness.root, 'archive-link.mcpack');
    await symlink(valid, archiveSymlink);
    await assert.rejects(
      harness.packs.importArchive(archiveSymlink),
      (error: unknown) => error instanceof BedrockPackManagerError && /lien symbolique/.test(error.message),
    );
  }

  const traversal = path.join(harness.root, 'traversal.zip');
  await writeZip(traversal, [
    { name: 'aa/escaped.txt', value: 'must not escape' },
    { name: 'manifest.json', value: packManifest('resource', 'a8a8a8a8-1234-4234-9234-123456789012') },
  ]);
  const archiveBytes = Buffer.from(await readFile(traversal));
  const safeName = Buffer.from('aa/escaped.txt');
  const traversalName = Buffer.from('../escaped.txt');
  let replacements = 0;
  for (let offset = archiveBytes.indexOf(safeName); offset >= 0; offset = archiveBytes.indexOf(safeName, offset + safeName.length)) {
    traversalName.copy(archiveBytes, offset);
    replacements += 1;
  }
  assert.equal(replacements, 2, 'patch both ZIP filename records without changing archive structure');
  await writeFile(traversal, archiveBytes);
  await assert.rejects(harness.packs.importArchive(traversal), /chemin absolu|hors du dossier|invalid relative path/i);
  await assert.rejects(readFile(path.join(harness.serverDirectory, 'escaped.txt')));
});

test('refuses to alter an unsafe world pack-list symlink', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Symlink permissions vary on Windows runners.');
    return;
  }
  const harness = await setup(t);
  const archivePath = path.join(harness.root, 'resource.mcpack');
  await makePackArchive(archivePath, 'resource', RESOURCE_UUID);
  await harness.packs.importArchive(archivePath);
  const target = path.join(harness.root, 'elsewhere.json');
  await writeFile(target, '[]');
  await symlink(target, path.join(harness.worldDirectory, 'world_resource_packs.json'));
  await assert.rejects(
    harness.packs.setActive(harness.world.id, RESOURCE_UUID, true),
    (error: unknown) => error instanceof BedrockPackManagerError && /lien symbolique|n’est pas sûr/.test(error.message),
  );
  assert.equal(await readFile(target, 'utf8'), '[]');
});
