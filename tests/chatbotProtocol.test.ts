import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assessChatbotProtocol, getTestedProtocolFamilies } from '../src/bedrock/chatbot/protocolSupport.ts';
import { parseChatbotTrigger } from '../src/bedrock/chatbot/manager.ts';
import type { VersionEntry } from '../src/types/backend.ts';

const catalogPath = path.resolve(process.cwd(), 'data', 'versions.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { versions: VersionEntry[] };

test('only the RakNet 11 / protocol 898 client family is enabled', () => {
  assert.deepEqual(getTestedProtocolFamilies(), { '1.21.130': 898 });
  const supportedBuilds = catalog.versions
    .filter((entry) => assessChatbotProtocol(entry).supported)
    .map((entry) => entry.version)
    .sort();
  assert.deepEqual(supportedBuilds, ['1.21.130.3', '1.21.130.4']);

  const newestBuild = catalog.versions.find((entry) => entry.version === '1.21.131.1')!;
  const unsupported = assessChatbotProtocol(newestBuild);
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.tested, false);
  assert.equal(unsupported.protocolVersion, null, 'the pinned protocol library has no 1.21.131 mapping');
});

test('chatbot command prefix is exact and requires a non-empty single-line message', () => {
  assert.equal(parseChatbotTrigger('.. bonjour'), 'bonjour');
  assert.equal(parseChatbotTrigger('..  bonjour  '), 'bonjour');
  assert.equal(parseChatbotTrigger('. bonjour'), null);
  assert.equal(parseChatbotTrigger('... bonjour'), null);
  assert.equal(parseChatbotTrigger('..'), null);
  assert.equal(parseChatbotTrigger('..   '), null);
  assert.equal(parseChatbotTrigger('.. question\nextra'), null);
  assert.equal(parseChatbotTrigger({ message: '.. hello' }), null);
});
