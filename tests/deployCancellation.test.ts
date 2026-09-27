import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadBedrockArchive } from '../src/bedrock/download.ts';
import { extractZipSafely } from '../src/bedrock/extractArchive.ts';

const officialUrl = 'https://minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.19.50.02.zip';

test('an already-aborted download does not create a partial archive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-download-abort-'));
  try {
    const destination = path.join(directory, 'archive.zip');
    const controller = new AbortController();
    controller.abort(new Error('test download cancellation'));
    await assert.rejects(
      downloadBedrockArchive(officialUrl, destination, 1024, controller.signal),
      /test download cancellation/,
    );
    await assert.rejects(access(destination));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('an already-aborted extraction creates no destination directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-extract-abort-'));
  try {
    const destination = path.join(directory, 'server');
    const controller = new AbortController();
    controller.abort(new Error('test extraction cancellation'));
    await assert.rejects(
      extractZipSafely(path.join(directory, 'missing.zip'), destination, controller.signal),
      /test extraction cancellation/,
    );
    await assert.rejects(access(destination));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
