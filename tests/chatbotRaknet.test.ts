import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSocket } from 'node:dgram';
import test from 'node:test';

const require = createRequire(import.meta.url);
const BedrockServer = (require('bedrock-protocol/src/server.js') as { Server: new(options: Record<string, unknown>) => any }).Server;
const BedrockClient = (require('bedrock-protocol/src/client.js') as { Client: new(options: Record<string, unknown>) => any }).Client;

async function freeUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

test('raknet-node completes a RakNet 11 / Bedrock 898 offline handshake and chat round trip', { timeout: 20_000 }, async () => {
  const port = await freeUdpPort();
  const server = new BedrockServer({
    host: '127.0.0.1',
    port,
    version: '1.21.130',
    offline: true,
    raknetBackend: 'raknet-node',
    maxPlayers: 2,
  });
  server.conLog = () => undefined;
  let serverListening = false;
  let client: any = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    await server.listen();
    serverListening = true;
    client = new BedrockClient({
      host: '127.0.0.1',
      port,
      username: 'NcraftLoopback',
      version: '1.21.130',
      offline: true,
      raknetBackend: 'raknet-node',
      useRaknetWorkers: false,
      conLog: () => undefined,
      delayedInit: true,
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => finish(new Error('RakNet 11 loopback timed out.')), 15_000);

      server.on('connect', (player: any) => {
        player.on('text', (packet: { message?: string; category?: string; type?: string }) => {
          try {
            assert.equal(packet.type, 'chat');
            assert.equal(packet.category, 'authored');
            assert.equal(packet.message, '.. protocol test');
            finish();
          } catch (error) {
            finish(error as Error);
          }
        });
        player.once('join', () => {
          setTimeout(() => {
            try {
              client.queue('text', {
                needs_translation: false,
                category: 'authored',
                chat: '.. protocol test',
                whisper: '',
                announcement: '',
                type: 'chat',
                source_name: 'NcraftLoopback',
                message: '.. protocol test',
                xuid: '0',
                platform_chat_id: '',
                has_filtered_message: false,
                filtered_message: '',
              });
            } catch (error) {
              finish(error as Error);
            }
          }, 100);
        });
      });
      client.on('error', (error: Error) => finish(error));
      client.on('connect_allowed', () => {
        try {
          assert.equal(client.options.protocolVersion, 898);
          client.connect();
        } catch (error) {
          finish(error as Error);
        }
      });
      client.init();
    });
  } finally {
    if (timer) clearTimeout(timer);
    try { client?.close(); } catch { /* The native client may already be closed. */ }
    if (serverListening) await server.close().catch(() => undefined);
  }
});
