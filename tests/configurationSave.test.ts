import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ServerRunningError, DeployPipeline } from '../src/bedrock/deployPipeline.ts';
import { writeBedrockConfiguration } from '../src/bedrock/configWriter.ts';
import { StateStore } from '../src/state.ts';
import type { DeployConfiguration } from '../src/types/backend.ts';

const previousConfiguration: DeployConfiguration = {
  version: '1.19.50.02',
  serverName: 'Nebula',
  levelName: 'NebulaWorld',
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 10,
  adminXuids: ['1234567890123456'],
  seed: 'original-seed',
  viewDistance: 10,
  allowCheats: false,
  eulaAccepted: true,
};

const editedConfiguration: DeployConfiguration = {
  ...previousConfiguration,
  serverName: 'Updated Nebula',
  difficulty: 'hard',
  maxPlayers: 12,
  allowCheats: true,
};

function createPipeline(
  state: StateStore,
  dataDirectory: string,
  serverDirectory: string,
  bedrockConsole: ConstructorParameters<typeof DeployPipeline>[1],
): DeployPipeline {
  const inspector = { inspect: async () => { throw new Error('Settings-only save must not run preflight.'); } } as unknown as ConstructorParameters<typeof DeployPipeline>[2];
  return new DeployPipeline(state, bedrockConsole, inspector, dataDirectory, serverDirectory, () => undefined);
}

test('saves Bedrock settings while stopped without starting the server or touching its world', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-settings-save-'));
  const dataDirectory = path.join(directory, 'data');
  const serverDirectory = path.join(directory, 'bedrock', 'server');
  const worldFile = path.join(serverDirectory, 'worlds', 'NebulaWorld', 'level.dat');
  const binaryPath = path.join(serverDirectory, 'bedrock_server');
  const bedrockConsole = Object.assign(new EventEmitter(), {
    isRunning: false,
    pid: null,
    stop: async () => undefined,
    start: async () => { throw new Error('Settings-only save must not start Bedrock.'); },
  }) as unknown as ConstructorParameters<typeof DeployPipeline>[1];

  try {
    await mkdir(path.dirname(worldFile), { recursive: true });
    await writeFile(worldFile, 'world data remains untouched', 'utf8');
    await writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
    await chmod(binaryPath, 0o755);
    await writeBedrockConfiguration(serverDirectory, previousConfiguration);
    await writeFile(path.join(serverDirectory, 'server.properties'), `${await readFile(path.join(serverDirectory, 'server.properties'), 'utf8')}custom-property=keep\n`, 'utf8');

    const state = new StateStore(dataDirectory);
    await state.initialize();
    await state.setActiveConfig(previousConfiguration);
    const pipeline = createPipeline(state, dataDirectory, serverDirectory, bedrockConsole);

    await pipeline.saveConfiguration(editedConfiguration);

    const properties = await readFile(path.join(serverDirectory, 'server.properties'), 'utf8');
    assert.match(properties, /^server-name=Updated Nebula$/m);
    assert.match(properties, /^difficulty=hard$/m);
    assert.match(properties, /^max-players=12$/m);
    assert.match(properties, /^allow-cheats=true$/m);
    assert.match(properties, /^custom-property=keep$/m);
    assert.equal(await readFile(worldFile, 'utf8'), 'world data remains untouched');
    assert.deepEqual(state.getSnapshot().activeConfig, editedConfiguration);
    assert.equal(state.getSnapshot().server.status, 'stopped');
    assert.equal(pipeline.isRunning, false);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('refuses settings-only edits while Bedrock is running', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-settings-running-'));
  const dataDirectory = path.join(directory, 'data');
  const serverDirectory = path.join(directory, 'bedrock', 'server');
  const propertiesPath = path.join(serverDirectory, 'server.properties');
  const bedrockConsole = Object.assign(new EventEmitter(), {
    isRunning: true,
    pid: 4321,
    stop: async () => undefined,
    start: async () => undefined,
  }) as unknown as ConstructorParameters<typeof DeployPipeline>[1];

  try {
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(path.join(serverDirectory, 'bedrock_server'), 'fixture', 'utf8');
    await writeBedrockConfiguration(serverDirectory, previousConfiguration);
    const originalProperties = await readFile(propertiesPath, 'utf8');
    const state = new StateStore(dataDirectory);
    await state.initialize();
    await state.setActiveConfig(previousConfiguration);
    const pipeline = createPipeline(state, dataDirectory, serverDirectory, bedrockConsole);

    await assert.rejects(pipeline.saveConfiguration(editedConfiguration), ServerRunningError);
    assert.equal(await readFile(propertiesPath, 'utf8'), originalProperties);
    assert.deepEqual(state.getSnapshot().activeConfig, previousConfiguration);
    assert.equal(pipeline.isRunning, false);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
