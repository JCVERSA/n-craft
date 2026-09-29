import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRakNetUnconnectedPing,
  parseBedrockEndpoint,
  parseRakNetUnconnectedPong,
  probeRakNetEndpoint,
} from '../src/networkProbe.ts';
import { StateStore } from '../src/state.ts';
import { BedrockNetworkMonitor } from '../src/networkProbe.ts';
import type { BedrockConsole } from '../src/bedrock/console.ts';

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

function makePong(timestamp: bigint, serverName: string): Buffer {
  const name = Buffer.from(serverName, 'utf8');
  const packet = Buffer.alloc(1 + 8 + 8 + MAGIC.length + 2 + name.length);
  packet[0] = 0x1c;
  packet.writeBigInt64BE(timestamp, 1);
  packet.writeBigInt64BE(0x0102030405060708n, 9);
  MAGIC.copy(packet, 17);
  packet.writeUInt16BE(name.length, 33);
  name.copy(packet, 35);
  return packet;
}

async function listen(socket: Socket): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert.equal(typeof address, 'object');
  return address.port;
}

test('parses IPv4, hostnames and bracketed IPv6 while rejecting URLs and invalid ports', () => {
  assert.deepEqual(parseBedrockEndpoint(' play.example.net:19133 '), { host: 'play.example.net', port: 19133 });
  assert.deepEqual(parseBedrockEndpoint('127.0.0.1'), { host: '127.0.0.1', port: 19132 });
  assert.deepEqual(parseBedrockEndpoint('[2001:db8::1]:19134'), { host: '2001:db8::1', port: 19134 });
  assert.equal(parseBedrockEndpoint('https://play.example.net'), null);
  assert.equal(parseBedrockEndpoint('play.example.net:0'), null);
  assert.equal(parseBedrockEndpoint('play.example.net:19132/path'), null);
  assert.deepEqual(parseBedrockEndpoint('2001:db8::1'), { host: '2001:db8::1', port: 19132 }, 'unbracketed IPv6 uses the default port');
});

test('builds a RakNet unconnected ping and parses only a matching pong', () => {
  const timestamp = 1_725_000_000_000n;
  const ping = buildRakNetUnconnectedPing(timestamp, Buffer.alloc(8, 7));
  assert.equal(ping.length, 33);
  assert.equal(ping[0], 0x01);
  assert.equal(ping.readBigInt64BE(1), timestamp);
  assert.ok(ping.subarray(9, 25).equals(MAGIC));
  assert.equal(ping.subarray(25).toString('hex'), '0707070707070707');

  const pong = makePong(timestamp, 'MCPE;Test Server;898;1.21;5;20;1234;Bedrock;Survival;1;19132;19133;');
  assert.equal(parseRakNetUnconnectedPong(pong, timestamp)?.startsWith('MCPE;Test Server'), true);
  assert.equal(parseRakNetUnconnectedPong(pong, timestamp + 1n), null);
  const corrupt = Buffer.from(pong);
  corrupt[20] ^= 0xff;
  assert.equal(parseRakNetUnconnectedPong(corrupt, timestamp), null);
});

test('measures UDP round-trip time against a responding RakNet endpoint', async (context) => {
  const server = createSocket('udp4');
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  let received = 0;
  server.on('message', (packet, remote) => {
    received += 1;
    if (packet[0] !== 0x01 || packet.length !== 33) return;
    const timestamp = packet.readBigInt64BE(1);
    server.send(makePong(timestamp, 'MCPE;Local Probe;898;1.21;1;10;1234;Bedrock;Survival;1;19132;19133;'), remote.port, remote.address);
  });
  const port = await listen(server);
  const result = await probeRakNetEndpoint({ host: '127.0.0.1', port }, 1000);
  assert.ok(result.latencyMs >= 0 && result.latencyMs < 1000);
  assert.match(result.serverName ?? '', /^MCPE;Local Probe/);
  received = 0;

  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-network-tunnel-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(directory);
  await state.initialize();
  await state.updateServer({ status: 'running', desiredRunning: true });
  await state.updatePortwarp({ address: `127.0.0.1:${port}` });
  const monitor = new BedrockNetworkMonitor(state, { isReady: true } as unknown as BedrockConsole, 'portwarp');
  const [first, second] = await Promise.all([monitor.probe('tunnel'), monitor.probe('tunnel')]);
  assert.equal(first.status, 'reachable');
  assert.equal(second.status, 'reachable');
  assert.equal(received, 1, 'concurrent UI/API probes to the same target share one UDP request');
  assert.match(first.message, /pas une sonde indépendante depuis un autre réseau/);
});

test('monitor reports a stopped server or an unavailable tunnel without claiming external reachability', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-network-monitor-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(directory);
  await state.initialize();
  const bedrock = { isReady: false } as BedrockConsole;
  const monitor = new BedrockNetworkMonitor(state, bedrock, 'portwarp');
  const stopped = await monitor.probe('local');
  assert.equal(stopped.status, 'server-stopped');
  assert.equal(stopped.source, 'local');

  await state.updateServer({ status: 'running', desiredRunning: true });
  (bedrock as unknown as { isReady: boolean }).isReady = true;
  const unconfigured = await monitor.probe('tunnel');
  assert.equal(unconfigured.status, 'unconfigured');
  assert.match(unconfigured.message, /Aucune adresse Bedrock publique/);
});
