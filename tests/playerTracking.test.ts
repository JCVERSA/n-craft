import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BedrockConsole } from '../src/bedrock/console.ts';

test('BedrockConsole emits connected player counts from live lifecycle logs', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The console fixture is a Linux shell executable.');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-player-tracking-'));
  const binaryPath = path.join(directory, 'bedrock_server');
  const consoleProcess = new BedrockConsole(directory);
  try {
    await writeFile(binaryPath, [
      '#!/bin/sh',
      "printf 'Server started\\n'",
      "printf 'Player connected: ExamplePlayer, xuid: 1234567890123456\\n'",
      'sleep 0.25',
      "printf 'Player disconnected: ExamplePlayer, xuid: 1234567890123456\\n'",
      'while IFS= read -r line; do [ "$line" = "stop" ] && exit 0; done',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    await chmod(binaryPath, 0o755);

    const counts: number[] = [];
    consoleProcess.on('players', (count: number) => counts.push(count));
    await consoleProcess.start({
      binaryPath,
      workingDirectory: directory,
      timeoutMs: 2000,
      onEulaPrompt: () => undefined,
    });

    const deadline = Date.now() + 2000;
    while ((!counts.includes(1) || counts.at(-1) !== 0) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(counts, [0, 1, 0]);
    assert.equal(consoleProcess.onlinePlayersCount, 0);
    await consoleProcess.stop(1000);
  } finally {
    await consoleProcess.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
