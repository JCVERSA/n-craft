import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeBedrockRelease } from '../src/bedrock/installRelease.ts';

async function writePackFile(directory: string, relativePath: string, contents: string): Promise<string> {
  const filePath = path.join(directory, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

test('refreshes official global vanilla packs while retaining custom packs and unrelated files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-release-packs-'));
  const stagingDirectory = path.join(directory, 'staging');
  const serverDirectory = path.join(directory, 'server');
  try {
    const oldBehaviorManifest = await writePackFile(
      serverDirectory,
      'behavior_packs/vanilla_1.17.20/manifest.json',
      '{"header":{"uuid":"11111111-1111-4111-8111-111111111111"},"content":"stale"}\n',
    );
    const oldResourceFile = await writePackFile(
      serverDirectory,
      'resource_packs/vanilla_1.17.20/textures/blocks.json',
      '{"content":"stale"}\n',
    );
    await writePackFile(
      serverDirectory,
      'resource_packs/vanilla_1.17.20/manifest.json',
      '{"header":{"uuid":"22222222-2222-4222-8222-222222222222"}}\n',
    );
    const customBehaviorManifest = await writePackFile(
      serverDirectory,
      'behavior_packs/CustomBehavior/manifest.json',
      '{"header":{"uuid":"33333333-3333-4333-8333-333333333333"}}\n',
    );
    const customResourceManifest = await writePackFile(
      serverDirectory,
      'resource_packs/CustomResource/manifest.json',
      '{"header":{"uuid":"44444444-4444-4444-8444-444444444444"}}\n',
    );
    const customResourceFile = await writePackFile(
      serverDirectory,
      'resource_packs/CustomResource/custom.json',
      '{"must":"remain untouched"}\n',
    );

    await writePackFile(
      stagingDirectory,
      'behavior_packs/vanilla_1.17.20/manifest.json',
      '{"header":{"uuid":"11111111-1111-4111-8111-111111111111"},"content":"current"}\n',
    );
    await writePackFile(
      stagingDirectory,
      'behavior_packs/vanilla_1.17.20/blocks/vanilla.json',
      '{"release":true}\n',
    );
    await writePackFile(
      stagingDirectory,
      'behavior_packs/CustomBehavior/manifest.json',
      '{"header":{"uuid":"55555555-5555-4555-8555-555555555555"}}\n',
    );
    await writePackFile(
      stagingDirectory,
      'behavior_packs/CustomBehavior/archive-only.json',
      '{"must":"not be copied over the custom pack"}\n',
    );
    await writePackFile(
      stagingDirectory,
      'resource_packs/vanilla_1.17.20/manifest.json',
      '{"header":{"uuid":"22222222-2222-4222-8222-222222222222"}}\n',
    );
    await writePackFile(
      stagingDirectory,
      'resource_packs/vanilla_1.17.20/textures/blocks.json',
      '{"content":"current"}\n',
    );
    await writePackFile(
      stagingDirectory,
      'resource_packs/OfficialNewPack/manifest.json',
      '{"header":{"uuid":"official-new"}}\n',
    );
    await writePackFile(stagingDirectory, 'bedrock_server', '#!/bin/sh\nexit 0\n');

    await mergeBedrockRelease(stagingDirectory, serverDirectory, { preserveExisting: true });

    assert.match(await readFile(oldBehaviorManifest, 'utf8'), /"content":"current"/);
    assert.equal(
      await readFile(path.join(serverDirectory, 'behavior_packs/vanilla_1.17.20/blocks/vanilla.json'), 'utf8'),
      '{"release":true}\n',
    );
    assert.match(await readFile(oldResourceFile, 'utf8'), /"content":"current"/);
    assert.equal(await readFile(customBehaviorManifest, 'utf8'), '{"header":{"uuid":"33333333-3333-4333-8333-333333333333"}}\n');
    await assert.rejects(
      readFile(path.join(serverDirectory, 'behavior_packs/CustomBehavior/archive-only.json'), 'utf8'),
      { code: 'ENOENT' },
    );
    assert.equal(await readFile(customResourceManifest, 'utf8'), '{"header":{"uuid":"44444444-4444-4444-8444-444444444444"}}\n');
    assert.equal(await readFile(customResourceFile, 'utf8'), '{"must":"remain untouched"}\n');
    assert.equal(
      await readFile(path.join(serverDirectory, 'resource_packs/OfficialNewPack/manifest.json'), 'utf8'),
      '{"header":{"uuid":"official-new"}}\n',
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
