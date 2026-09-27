import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BedrockConsole } from '../src/bedrock/console.ts';

async function runFakeServer(scriptBody: string, timeoutMs: number): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-console-stop-'));
  const binaryPath = path.join(directory, 'fake-bedrock');
  const bedrockConsole = new BedrockConsole(path.join(directory, 'data'));
  try {
    await writeFile(binaryPath, `#!/bin/sh\n${scriptBody}\n`, { encoding: 'utf8', mode: 0o755 });
    const exited = once(bedrockConsole, 'exit');
    await bedrockConsole.start({
      binaryPath,
      workingDirectory: directory,
      timeoutMs: 3000,
      onEulaPrompt: () => undefined,
    });
    assert.equal(bedrockConsole.isReady, true);
    await bedrockConsole.stop(timeoutMs);
    await exited;
    assert.equal(bedrockConsole.isRunning, false);
  } finally {
    await bedrockConsole.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test('STOP first sends the Bedrock console stop command', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Bedrock process lifecycle test uses a Linux executable script.');
    return;
  }
  await runFakeServer(
    'printf "Server started\\n"\nwhile IFS= read -r line; do\n  if [ "$line" = "stop" ]; then exit 0; fi\ndone',
    1000,
  );
});

test('reports an unexpected exit after the process had become ready', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Bedrock process lifecycle test uses a Linux executable script.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nebula-console-exit-'));
  const binaryPath = path.join(directory, 'fake-bedrock');
  const bedrockConsole = new BedrockConsole(path.join(directory, 'data'));
  try {
    const script = ['#!/bin/sh', 'printf "Server started\\n"', 'sleep 0.1', 'exit 7', ''].join('\n');
    await writeFile(binaryPath, script, { encoding: 'utf8', mode: 0o755 });
    const exitEvent = once(bedrockConsole, 'exit');
    await bedrockConsole.start({
      binaryPath,
      workingDirectory: directory,
      timeoutMs: 3000,
      onEulaPrompt: () => undefined,
    });
    const [event] = await exitEvent as [{ code: number | null; wasReady: boolean; intentional: boolean }];
    assert.equal(event.code, 7);
    assert.equal(event.wasReady, true);
    assert.equal(event.intentional, false);
  } finally {
    await bedrockConsole.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('STOP falls back to SIGTERM and SIGKILL, then waits for process exit', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The Bedrock process lifecycle test uses a Linux executable script.');
    return;
  }
  await runFakeServer(
    'trap \'\' TERM\nprintf "Server started\\n"\nwhile true; do IFS= read -r line || :; done',
    1000,
  );
});
