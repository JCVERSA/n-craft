import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlayitIpcClient } from '../src/playit/playitIpc.ts';

test('rejects a Playit IPC hello that does not advertise version 2', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Playit IPC protocol test uses a Unix-domain socket.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-playit-protocol-'));
  const socketPath = path.join(directory, 'daemon.sock');
  const server = net.createServer((socket) => {
    socket.write(`${JSON.stringify({
      message_kind: 'hello',
      data: { protocol: { ipc_version: 1, capabilities: [] } },
    })}\n`);
  });
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    await assert.rejects(
      PlayitIpcClient.connect(socketPath, new AbortController().signal, 1000),
      /unsupported IPC hello\/version/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
