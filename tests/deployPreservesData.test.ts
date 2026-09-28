import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BedrockConsole } from '../src/bedrock/console.ts';
import { DeployPipeline } from '../src/bedrock/deployPipeline.ts';
import { StateStore } from '../src/state.ts';
import type { DeployConfiguration, SystemPreflight, VersionEntry } from '../src/types/backend.ts';
import type { BedrockRuntimeSupport } from '../src/bedrock/runtimeDependencies.ts';

const oldConfiguration: DeployConfiguration = {
  version: '1.19.50.02',
  serverName: 'Existing server name',
  levelName: 'PreservedWorld',
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 8,
  adminXuids: ['1234567890123456'],
  seed: 'kept-seed',
  viewDistance: 8,
  allowCheats: false,
  eulaAccepted: true,
};

const requestedConfiguration: DeployConfiguration = {
  ...oldConfiguration,
  version: '1.20.10.01',
  serverName: 'Must not replace existing settings',
  levelName: 'DifferentWorld',
  maxPlayers: 20,
  adminXuids: ['9999999999999999'],
};

const preflight: SystemPreflight = {
  checkedAt: new Date().toISOString(),
  platform: 'linux',
  arch: 'x64',
  nodeVersion: 'v22.12.0',
  glibcVersion: '2.36',
  glibc: { ok: true, detail: 'ok' },
  libcurl: { ok: true, detail: 'ok' },
  legacyOpenSsl: { ok: false, detail: 'not installed in test fixture' },
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
  portwarpBinary: { ok: false, detail: 'missing' },
  playitBinary: { ok: false, detail: 'missing' },
  playitCliBinary: { ok: false, detail: 'missing' },
  localtonetBinary: { ok: false, detail: 'missing' },
  bedrockBinary: { ok: true, detail: 'already deployed' },
  deployReady: true,
  warnings: [],
};

const fixtureRuntimeDependencies: BedrockRuntimeSupport = {
  ensureForBinary: async () => undefined,
  libraryDirectories: () => [],
};

async function waitForUpdatedProcess(state: StateStore, previousPid: number | null): Promise<void> {
  const isUpdated = (snapshot: ReturnType<StateStore['getSnapshot']>) =>
    snapshot.server.status === 'running' &&
    snapshot.server.pid !== previousPid &&
    snapshot.activeConfig?.version === requestedConfiguration.version;
  if (isUpdated(state.getSnapshot())) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.removeListener('change', onChange);
      reject(new Error('Timed out waiting for the updated Bedrock process.'));
    }, 5000);
    const onChange = (snapshot: ReturnType<StateStore['getSnapshot']>) => {
      if (!isUpdated(snapshot)) return;
      clearTimeout(timer);
      state.removeListener('change', onChange);
      resolve();
    };
    state.on('change', onChange);
  });
}

function testVersion(version: string): VersionEntry {
  return {
    version,
    clientVersion: version.split('.').slice(0, 3).join('.'),
    channel: 'stable',
    label: version,
    downloadUrl: `https://minecraft.azureedge.net/bin-linux/bedrock-server-${version}.zip`,
    releaseDate: null,
  };
}

test('Deploy merges the release and restarts while preserving worlds, packs, permissions and settings', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Bedrock child-process fixture is a Linux executable script.');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-deploy-preserve-'));
  const dataDirectory = path.join(directory, 'data');
  const serverDirectory = path.join(directory, 'bedrock', 'server');
  const worldPath = path.join(serverDirectory, 'worlds', 'PreservedWorld', 'level.dat');
  const packPath = path.join(serverDirectory, 'resource_packs', 'CustomPack', 'manifest.json');
  const vanillaBehaviorPackPath = path.join(serverDirectory, 'behavior_packs', 'vanilla_1.17.20', 'manifest.json');
  const vanillaResourcePackPath = path.join(serverDirectory, 'resource_packs', 'vanilla_1.17.20', 'manifest.json');
  const propertiesPath = path.join(serverDirectory, 'server.properties');
  const permissionsPath = path.join(serverDirectory, 'permissions.json');
  const allowlistPath = path.join(serverDirectory, 'allowlist.json');
  const oldBinaryPath = path.join(serverDirectory, 'bedrock_server');
  const bedrockConsole = new BedrockConsole(dataDirectory);

  try {
    await mkdir(path.dirname(worldPath), { recursive: true });
    await mkdir(path.dirname(packPath), { recursive: true });
    await writeFile(worldPath, 'world snapshot must survive', 'utf8');
    await writeFile(packPath, '{"name":"custom pack"}\n', 'utf8');
    await mkdir(path.dirname(vanillaBehaviorPackPath), { recursive: true });
    await mkdir(path.dirname(vanillaResourcePackPath), { recursive: true });
    await writeFile(vanillaBehaviorPackPath, '{"header":{"uuid":"11111111-1111-4111-8111-111111111111"},"source":"old"}\n', 'utf8');
    await writeFile(vanillaResourcePackPath, '{"header":{"uuid":"22222222-2222-4222-8222-222222222222"},"source":"old"}\n', 'utf8');
    await writeFile(propertiesPath, 'server-name=Existing server name\nlevel-name=PreservedWorld\nmax-players=8\n', 'utf8');
    await writeFile(permissionsPath, '[{"permission":"operator","xuid":"1234567890123456"}]\n', 'utf8');
    await writeFile(allowlistPath, '[{"name":"Existing player","ignoresPlayerLimit":false}]\n', 'utf8');
    await writeFile(path.join(serverDirectory, 'custom-backup.txt'), 'keep unknown data', 'utf8');
    await writeFile(oldBinaryPath, [
      '#!/bin/sh',
      'printf "Server started\\n"',
      'while IFS= read -r line; do [ "$line" = "stop" ] && exit 0; done',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    await chmod(oldBinaryPath, 0o755);

    const state = new StateStore(dataDirectory);
    await state.initialize();
    await state.setActiveConfig(oldConfiguration);
    await bedrockConsole.start({
      binaryPath: oldBinaryPath,
      workingDirectory: serverDirectory,
      timeoutMs: 2000,
      onEulaPrompt: () => undefined,
    });
    const previousPid = bedrockConsole.pid;
    await state.updateServer({
      status: 'running',
      pid: previousPid,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      playersOnline: 0,
      error: null,
    });
    const inspector = { inspect: async () => preflight } as unknown as ConstructorParameters<typeof DeployPipeline>[2];
    const pipeline = new DeployPipeline(
      state,
      bedrockConsole,
      inspector,
      dataDirectory,
      serverDirectory,
      (version) => version === requestedConfiguration.version ? testVersion(version) : undefined,
      {
        download: async (_url, destination) => {
          assert.equal(bedrockConsole.isReady, true, 'the previous Bedrock process stays online while the ZIP downloads');
          await writeFile(destination, Buffer.from('fixture zip'));
          return { bytes: 10, finalUrl: 'https://fixture.invalid/release.zip' };
        },
        extract: async (_archive, destination) => {
          assert.equal(bedrockConsole.isReady, true, 'the previous Bedrock process stays online while the ZIP is extracted');
          const newBinary = [
            '#!/bin/sh',
            'printf "Server started\\n"',
            'while IFS= read -r line; do [ "$line" = "stop" ] && exit 0; done',
            '',
          ].join('\n');
          await writeFile(path.join(destination, 'bedrock_server'), newBinary, { encoding: 'utf8', mode: 0o600 });
          await writeFile(path.join(destination, 'runtime-version.txt'), 'new runtime files', 'utf8');
          await writeFile(path.join(destination, 'server.properties'), 'server-name=archive default\n', 'utf8');
          await writeFile(path.join(destination, 'permissions.json'), '[]\n', 'utf8');
          await writeFile(path.join(destination, 'allowlist.json'), '[]\n', 'utf8');
          await mkdir(path.join(destination, 'worlds', 'ArchiveWorld'), { recursive: true });
          await writeFile(path.join(destination, 'worlds', 'ArchiveWorld', 'level.dat'), 'archive world', 'utf8');
          await mkdir(path.join(destination, 'behavior_packs', 'vanilla_1.17.20'), { recursive: true });
          await writeFile(path.join(destination, 'behavior_packs', 'vanilla_1.17.20', 'manifest.json'), '{"header":{"uuid":"11111111-1111-4111-8111-111111111111"},"source":"current"}\n', 'utf8');
          await writeFile(path.join(destination, 'behavior_packs', 'vanilla_1.17.20', 'vanilla.json'), '{"release":true}\n', 'utf8');
          await mkdir(path.join(destination, 'resource_packs', 'vanilla_1.17.20'), { recursive: true });
          await writeFile(path.join(destination, 'resource_packs', 'vanilla_1.17.20', 'manifest.json'), '{"header":{"uuid":"22222222-2222-4222-8222-222222222222"},"source":"current"}\n', 'utf8');
          await mkdir(path.join(destination, 'resource_packs', 'ArchivePack'), { recursive: true });
          await writeFile(path.join(destination, 'resource_packs', 'ArchivePack', 'manifest.json'), '{}', 'utf8');
        },
      },
      undefined,
      fixtureRuntimeDependencies,
    );

    const started = waitForUpdatedProcess(state, previousPid);
    pipeline.start(requestedConfiguration);
    await started;
    const deadline = Date.now() + 5000;
    while (pipeline.isRunning && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));

    assert.equal(await readFile(worldPath, 'utf8'), 'world snapshot must survive');
    assert.equal(await readFile(packPath, 'utf8'), '{"name":"custom pack"}\n');
    assert.match(await readFile(vanillaBehaviorPackPath, 'utf8'), /\"source\":\"current\"/);
    assert.match(await readFile(vanillaResourcePackPath, 'utf8'), /\"source\":\"current\"/);
    assert.equal(await readFile(path.join(serverDirectory, 'behavior_packs', 'vanilla_1.17.20', 'vanilla.json'), 'utf8'), '{"release":true}\n');
    assert.equal(await readFile(path.join(serverDirectory, 'resource_packs', 'ArchivePack', 'manifest.json'), 'utf8'), '{}');
    assert.equal(await readFile(propertiesPath, 'utf8'), 'server-name=Existing server name\nlevel-name=PreservedWorld\nmax-players=8\n');
    assert.equal(await readFile(permissionsPath, 'utf8'), '[{"permission":"operator","xuid":"1234567890123456"}]\n');
    assert.equal(await readFile(allowlistPath, 'utf8'), '[{"name":"Existing player","ignoresPlayerLimit":false}]\n');
    assert.equal(await readFile(path.join(serverDirectory, 'custom-backup.txt'), 'utf8'), 'keep unknown data');
    assert.equal(await readFile(path.join(serverDirectory, 'runtime-version.txt'), 'utf8'), 'new runtime files');
    assert.match(await readFile(oldBinaryPath, 'utf8'), /Server started/);
    assert.equal(state.getSnapshot().activeConfig?.version, requestedConfiguration.version);
    assert.equal(state.getSnapshot().activeConfig?.serverName, oldConfiguration.serverName);
    assert.equal(state.getSnapshot().server.status, 'running');
    assert.notEqual(state.getSnapshot().server.pid, previousPid, 'the updated release is running in a fresh process');
    assert.equal(pipeline.isRunning, false);
    assert.deepEqual((await readdir(path.dirname(serverDirectory))).filter((name) => name.startsWith('.ncraft-bedrock-stage-')), []);

    await pipeline.stop();
    assert.equal(await readFile(worldPath, 'utf8'), 'world snapshot must survive');
  } finally {
    await bedrockConsole.stop(1000).catch(() => undefined);
    await bedrockConsole.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('a stopped server applies edited settings during Deploy while preserving the old world', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Bedrock child-process fixture is a Linux executable script.');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-deploy-settings-'));
  const dataDirectory = path.join(directory, 'data');
  const serverDirectory = path.join(directory, 'bedrock', 'server');
  const worldPath = path.join(serverDirectory, 'worlds', 'PreservedWorld', 'level.dat');
  const propertiesPath = path.join(serverDirectory, 'server.properties');
  const permissionsPath = path.join(serverDirectory, 'permissions.json');
  const bedrockConsole = new BedrockConsole(dataDirectory);

  try {
    await mkdir(path.dirname(worldPath), { recursive: true });
    await writeFile(worldPath, 'world snapshot must survive', 'utf8');
    await writeFile(propertiesPath, [
      'server-name=Existing server name',
      'level-name=PreservedWorld',
      'gamemode=survival',
      'difficulty=normal',
      'max-players=8',
      'level-seed=kept-seed',
      'view-distance=8',
      'allow-cheats=false',
      'server-port=19132',
      'online-mode=false',
      'allow-list=false',
      'custom-property=keep',
      '',
    ].join('\n'), 'utf8');
    await writeFile(permissionsPath, JSON.stringify([
      { permission: 'operator', xuid: oldConfiguration.adminXuids[0] },
      { permission: 'member', xuid: '2222222222222222' },
    ]), 'utf8');
    const state = new StateStore(dataDirectory);
    await state.initialize();
    await state.setActiveConfig(oldConfiguration);
    const inspector = { inspect: async () => preflight } as unknown as ConstructorParameters<typeof DeployPipeline>[2];
    const pipeline = new DeployPipeline(
      state,
      bedrockConsole,
      inspector,
      dataDirectory,
      serverDirectory,
      (version) => version === requestedConfiguration.version ? testVersion(version) : undefined,
      {
        download: async (_url, destination) => {
          await writeFile(destination, Buffer.from('fixture zip'));
          return { bytes: 10, finalUrl: 'https://fixture.invalid/release.zip' };
        },
        extract: async (_archive, destination) => {
          const newBinary = [
            '#!/bin/sh',
            'printf "Server started\\n"',
            'while IFS= read -r line; do [ "$line" = "stop" ] && exit 0; done',
            '',
          ].join('\n');
          await writeFile(path.join(destination, 'bedrock_server'), newBinary, { encoding: 'utf8', mode: 0o600 });
        },
      },
      undefined,
      fixtureRuntimeDependencies,
    );

    const started = waitForUpdatedProcess(state, null);
    pipeline.start(requestedConfiguration);
    await started;
    const deadline = Date.now() + 5000;
    while (pipeline.isRunning && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const properties = await readFile(propertiesPath, 'utf8');
    const permissions = JSON.parse(await readFile(permissionsPath, 'utf8')) as unknown;
    assert.match(properties, /^server-name=Must not replace existing settings$/m);
    assert.match(properties, /^level-name=DifferentWorld$/m);
    assert.match(properties, /^max-players=20$/m);
    assert.match(properties, /^server-port=19132$/m);
    assert.match(properties, /^custom-property=keep$/m);
    assert.deepEqual(permissions, [
      { permission: 'member', xuid: '2222222222222222' },
      { permission: 'operator', xuid: '9999999999999999' },
    ]);
    assert.equal(await readFile(worldPath, 'utf8'), 'world snapshot must survive');
    assert.deepEqual(state.getSnapshot().activeConfig, requestedConfiguration);
    assert.equal(state.getSnapshot().server.status, 'running');
    await pipeline.stop();
  } finally {
    await bedrockConsole.stop(1000).catch(() => undefined);
    await bedrockConsole.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
