import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigurationError, validateDeployConfiguration, writeBedrockConfiguration } from '../src/bedrock/configWriter.ts';

const allowedVersions = new Set(['1.19.50.02']);
const validInput = {
  version: '1.19.50.02',
  serverName: 'Nebula Test',
  levelName: 'TestWorld',
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 8,
  adminXuids: ['2535412894129841'],
  seed: '',
  viewDistance: 10,
  allowCheats: false,
  eulaAccepted: true,
};

test('rejects non-numeric XUIDs, whitespace and gamertags', () => {
  for (const invalid of ['gamertag', '123 456', '123\n456', '']) {
    assert.throws(
      () => validateDeployConfiguration({ ...validInput, adminXuids: [invalid] }, allowedVersions),
      ConfigurationError,
    );
  }
});

test('rejects level names that could escape the managed worlds directory', () => {
  for (const levelName of ['../outside', '..\\\\outside', '.', '..', 'C:outside']) {
    assert.throws(
      () => validateDeployConfiguration({ ...validInput, levelName }, allowedVersions),
      /séparateur ou de chemin relatif/,
    );
  }
});

test('rejects non-positive max players and an unacknowledged EULA', () => {
  assert.throws(() => validateDeployConfiguration({ ...validInput, maxPlayers: 0 }, allowedVersions), /entier positif/);
  assert.throws(() => validateDeployConfiguration({ ...validInput, eulaAccepted: false }, allowedVersions), /EULA/);
});

test('generates locked Bedrock settings and removes any archive allowlist', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-config-'));
  try {
    await writeFile(path.join(directory, 'allowlist.json'), '[{"name":"old"}]', 'utf8');
    await writeFile(path.join(directory, 'whitelist.json'), '[{"name":"old"}]', 'utf8');
    const configuration = validateDeployConfiguration(validInput, allowedVersions);
    await writeBedrockConfiguration(directory, configuration);

    const properties = await readFile(path.join(directory, 'server.properties'), 'utf8');
    const permissions = JSON.parse(await readFile(path.join(directory, 'permissions.json'), 'utf8')) as unknown;
    assert.match(properties, /^server-port=19132$/m);
    assert.match(properties, /^server-portv6=19133$/m);
    assert.match(properties, /^online-mode=false$/m);
    assert.match(properties, /^allow-list=false$/m);
    assert.match(properties, /^allow-cheats=false$/m);
    assert.doesNotMatch(properties, /allowlist\.json|whitelist/i);
    assert.deepEqual(permissions, [{ permission: 'operator', xuid: '2535412894129841' }]);
    await assert.rejects(readFile(path.join(directory, 'allowlist.json')));
    await assert.rejects(readFile(path.join(directory, 'whitelist.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
