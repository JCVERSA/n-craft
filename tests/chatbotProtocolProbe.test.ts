import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  resolveProtocolProbeTarget,
  runChatbotBdsProtocolProbe,
  type ProbeClient,
} from '../src/bedrock/chatbot/protocolProbe.ts';
import type { VersionEntry } from '../src/types/backend.ts';

const catalogPath = path.resolve(process.cwd(), 'data', 'versions.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { versions: VersionEntry[] };

function build(version: string): VersionEntry {
  const entry = catalog.versions.find((candidate) => candidate.version === version);
  assert.ok(entry, `catalogue missing ${version}`);
  return entry;
}

test('probe maps the requested range endpoints to installed packet schemas', () => {
  assert.deepEqual(
    {
      supported: resolveProtocolProbeTarget(build('1.19.50.02')).supported,
      clientVersion: resolveProtocolProbeTarget(build('1.19.50.02')).clientVersion,
      protocolVersion: resolveProtocolProbeTarget(build('1.19.50.02')).protocolVersion,
      usesAlias: resolveProtocolProbeTarget(build('1.19.50.02')).usesAlias,
    },
    { supported: true, clientVersion: '1.19.50', protocolVersion: 560, usesAlias: false },
  );
  assert.deepEqual(
    {
      supported: resolveProtocolProbeTarget(build('1.20.81.01')).supported,
      clientVersion: resolveProtocolProbeTarget(build('1.20.81.01')).clientVersion,
      protocolVersion: resolveProtocolProbeTarget(build('1.20.81.01')).protocolVersion,
      usesAlias: resolveProtocolProbeTarget(build('1.20.81.01')).usesAlias,
    },
    { supported: true, clientVersion: '1.20.80', protocolVersion: 671, usesAlias: true },
  );
  assert.deepEqual(
    {
      supported: resolveProtocolProbeTarget(build('1.21.131.1')).supported,
      clientVersion: resolveProtocolProbeTarget(build('1.21.131.1')).clientVersion,
      protocolVersion: resolveProtocolProbeTarget(build('1.21.131.1')).protocolVersion,
      usesAlias: resolveProtocolProbeTarget(build('1.21.131.1')).usesAlias,
    },
    { supported: true, clientVersion: '1.21.130', protocolVersion: 898, usesAlias: true },
  );
});

test('probe refuses a version without an installed packet schema instead of guessing', () => {
  const assessment = resolveProtocolProbeTarget({ version: '1.21.123.1', clientVersion: '1.21.123' });
  assert.equal(assessment.supported, false);
  assert.equal(assessment.protocolVersion, null);
  assert.match(assessment.reason, /ne possède pas de schéma réseau/);
});

class FakeProbeClient extends EventEmitter implements ProbeClient {
  readonly username: string;
  constructor(readonly options: Record<string, unknown>) {
    super();
    this.username = String(options.username);
  }
  init(): void { queueMicrotask(() => this.emit('connect_allowed')); }
  connect(): void { queueMicrotask(() => this.emit('spawn')); }
  queue(name: string, packet: Record<string, unknown>): void {
    assert.equal(name, 'text');
    const peer = FakeProbeClient.instances.find((client) => client !== this);
    assert.ok(peer);
    queueMicrotask(() => peer.emit('text', { type: 'chat', message: packet.message }));
  }
  disconnect(): void {}
  close(): void {}
  static instances: FakeProbeClient[] = [];
}

test('probe connects two offline loopback clients and requires a relayed chat marker', async () => {
  FakeProbeClient.instances = [];
  const result = await runChatbotBdsProtocolProbe({
    entry: build('1.19.50.02'),
    port: 29_132,
    timeoutMs: 2_000,
    clientFactory: (options) => {
      const client = new FakeProbeClient(options);
      FakeProbeClient.instances.push(client);
      return client;
    },
  });

  assert.deepEqual(result, {
    build: '1.19.50.02',
    clientVersion: '1.19.50',
    protocolVersion: 560,
    markerRelayed: true,
  });
  assert.equal(FakeProbeClient.instances.length, 2);
  for (const client of FakeProbeClient.instances) {
    assert.equal(client.options.host, '127.0.0.1');
    assert.equal(client.options.offline, true);
    assert.equal(client.options.raknetBackend, 'raknet-node');
  }
});

test('probe rejects invalid ports before creating any network client', async () => {
  let created = false;
  await assert.rejects(
    runChatbotBdsProtocolProbe({
      entry: build('1.19.50.02'),
      port: 0,
      clientFactory: () => { created = true; throw new Error('should not be called'); },
    }),
    /port de test doit être un entier/,
  );
  assert.equal(created, false);
});
