import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatbotAuthCacheStore, CHATBOT_AUTHFLOW_USERNAME } from '../src/bedrock/chatbot/authCache.ts';

async function makeDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'ncraft-chatbot-auth-'));
}

test('OAuth cache uses private directories and atomic 0600 token files', async (t) => {
  const root = await makeDirectory();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const chatbotDirectory = path.join(root, 'bedrock-chatbot');
  const store = new ChatbotAuthCacheStore(chatbotDirectory);
  await store.initialize();
  store.setWritesAllowed(true);

  const cache = store.factory({ cacheName: 'live', username: CHATBOT_AUTHFLOW_USERNAME });
  await cache.setCached({ token: { refresh_token: 'fake-refresh-token' } });
  assert.deepEqual(await cache.getCached(), { token: { refresh_token: 'fake-refresh-token' } });

  const authInfo = await stat(store.directory);
  const tokenPath = path.join(store.directory, 'live-cache.json');
  assert.equal(authInfo.mode & 0o777, 0o700);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(tokenPath, 'utf8')).includes('fake-refresh-token'), true);

  await store.markLinked(Date.UTC(2026, 8, 28));
  const marker = JSON.parse(await readFile(store.linkedMarkerPath, 'utf8')) as Record<string, unknown>;
  assert.equal(marker.linked, true);
  assert.equal(Object.hasOwn(marker, 'username'), false);
  assert.equal((await stat(store.linkedMarkerPath)).mode & 0o777, 0o600);
  assert.equal(await store.isLinked(), true);
});

test('cancelled OAuth writes are rejected and unlinked caches can be deleted', async (t) => {
  const root = await makeDirectory();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new ChatbotAuthCacheStore(path.join(root, 'bedrock-chatbot'));
  await store.initialize();
  store.setWritesAllowed(true);
  const cache = store.factory({ cacheName: 'xbl', username: CHATBOT_AUTHFLOW_USERNAME });
  await cache.setCached({ session: 'fake-session' });
  store.setWritesAllowed(false);
  await assert.rejects(cache.setCached({ session: 'late-write' }), /annulée/);
  assert.deepEqual(await cache.getCached(), { session: 'fake-session' });

  store.setWritesAllowed(true);
  const racingWrite = cache.setCached({ session: 'write racing with cancellation' });
  const racingWriteRejected = assert.rejects(racingWrite, /annulée/);
  store.setWritesAllowed(false);
  await store.clearUnlinkedCaches();
  await racingWriteRejected;
  await assert.rejects(lstat(path.join(store.directory, 'xbl-cache.json')), { code: 'ENOENT' });
  assert.equal(await store.isLinked(), false);
});

test('OAuth cache rejects symlinks and only accepts fixed cache names', async (t) => {
  const root = await makeDirectory();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new ChatbotAuthCacheStore(path.join(root, 'bedrock-chatbot'));
  await store.initialize();
  store.setWritesAllowed(true);

  const outsidePath = path.join(root, 'outside.json');
  await writeFile(outsidePath, '{"secret":"not for chatbot"}\n', { mode: 0o600 });
  await chmod(outsidePath, 0o600);
  await symlink(outsidePath, path.join(store.directory, 'live-cache.json'));
  const cache = store.factory({ cacheName: 'live', username: CHATBOT_AUTHFLOW_USERNAME });
  await assert.rejects(cache.getCached(), /pas sûr/);
  assert.throws(() => store.factory({ cacheName: '../../outside', username: CHATBOT_AUTHFLOW_USERNAME }), /non autorisée/);
  assert.throws(() => store.factory({ cacheName: 'live', username: 'player-email@example.com' }), /non autorisée/);
});
