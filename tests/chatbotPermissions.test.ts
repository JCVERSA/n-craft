import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkBedrockOperatorXuid } from '../src/bedrock/chatbot/permissions.ts';

test('chatbot refuses operator XUIDs and fails closed on unverifiable permissions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-chatbot-permissions-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, 'server');
  await mkdir(serverDirectory);
  const permissionsPath = path.join(serverDirectory, 'permissions.json');
  await writeFile(permissionsPath, JSON.stringify([
    { permission: 'operator', xuid: '1234567890123456' },
    { permission: 'member', xuid: '9876543210123456' },
  ]));

  assert.equal(await checkBedrockOperatorXuid(serverDirectory, '1234567890123456'), 'operator');
  assert.equal(await checkBedrockOperatorXuid(serverDirectory, '9876543210123456'), 'not_operator');
  assert.equal(await checkBedrockOperatorXuid(serverDirectory, '0'), 'unknown');

  await writeFile(permissionsPath, '{ malformed');
  assert.equal(await checkBedrockOperatorXuid(serverDirectory, '9876543210123456'), 'unknown');

  const externalPermissions = path.join(root, 'external.json');
  await writeFile(externalPermissions, '[]');
  await rm(permissionsPath);
  await symlink(externalPermissions, permissionsPath);
  assert.equal(await checkBedrockOperatorXuid(serverDirectory, '9876543210123456'), 'unknown');
});
