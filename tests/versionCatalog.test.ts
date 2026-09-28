import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VersionCatalog, compareNumericVersions } from '../src/versionCatalog.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('ships the stable BDS history below client 1.21.132 with numeric ordering and official URLs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-versions-'));
  try {
    const catalog = new VersionCatalog(directory, path.join(ROOT, 'data', 'versions.json'));
    await catalog.load();
    const entries = catalog.all();
    assert.equal(entries.length, 160, 'all and only the verified official Linux BDS archives should be listed');
    // These three history entries currently return BlobNotFound from Mojang's official archive host.
    assert.ok(entries.every((entry) => !['1.21.50.07', '1.21.40.01', '1.16.10.02'].includes(entry.version)));
    assert.equal(entries[0]?.version, '1.21.131.1');
    assert.equal(entries.at(-1)?.version, '1.6.1.0');
    assert.ok(entries.every((entry) => compareNumericVersions(entry.clientVersion, '1.21.132') < 0));
    assert.ok(entries.every((entry) => entry.channel === 'stable'));
    assert.ok(entries.every((entry) => entry.releaseDate === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)));
    assert.ok(entries.every((entry) => {
      const url = new URL(entry.downloadUrl);
      return url.protocol === 'https:'
        && url.hostname === 'www.minecraft.net'
        && url.pathname === `/bedrockdedicatedserver/bin-linux/bedrock-server-${entry.version}.zip`;
    }));
    assert.equal(catalog.publicEntries().some((entry) => 'downloadUrl' in entry), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compares numeric version components rather than lexicographic strings', () => {
  assert.equal(compareNumericVersions('1.21.9', '1.21.10'), -1);
  assert.equal(compareNumericVersions('1.21.132', '1.21.132.0'), 0);
  assert.equal(compareNumericVersions('1.21.131.9', '1.21.132'), -1);
});
