import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatbotAIService, type ChatbotAIMessage } from '../src/bedrock/chatbot/aiService.ts';

async function makeDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'ncraft-chatbot-ai-'));
}

test('shared conversation keeps at most ten exchanges and expires after thirty minutes', async (t) => {
  const root = await makeDirectory();
  t.after(async () => rm(root, { recursive: true, force: true }));
  let now = Date.UTC(2026, 8, 28, 12, 0, 0);
  const prompts: ChatbotAIMessage[][] = [];
  const service = new ChatbotAIService(root, {
    now: () => now,
    environment: { CHATBOT_DAILY_LIMIT: '50' },
    providers: {
      gemini: async (messages) => {
        prompts.push([...messages]);
        return 'Réponse courte';
      },
    },
  });
  await service.initialize();

  for (let index = 1; index <= 12; index += 1) {
    const result = await service.answer(`question-${index}`);
    assert.equal(result.status, 'answered');
  }
  const latestPrompt = prompts.at(-1)!;
  assert.equal(latestPrompt.length, 21, 'ten previous exchanges plus the current question');
  assert.equal(latestPrompt[0]?.content, 'question-2');
  assert.equal(latestPrompt.at(-1)?.content, 'question-12');
  assert.equal(service.dailyUsed, 12);

  now += 30 * 60 * 1000 + 1;
  const afterExpiry = await service.answer('fresh-topic');
  assert.equal(afterExpiry.status, 'answered');
  assert.deepEqual(prompts.at(-1), [{ role: 'user', content: 'fresh-topic' }]);
  service.shutdown();
});

test('Gemini is primary, NVIDIA is a sequential fallback, and only one request runs at a time', async (t) => {
  const root = await makeDirectory();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const order: string[] = [];
  let releaseGemini!: () => void;
  let notifyGeminiStarted!: () => void;
  const geminiStarted = new Promise<void>((resolve) => { notifyGeminiStarted = resolve; });
  const service = new ChatbotAIService(root, {
    environment: { CHATBOT_DAILY_LIMIT: '10' },
    providers: {
      gemini: async () => {
        order.push('gemini');
        notifyGeminiStarted();
        await new Promise<void>((resolve) => { releaseGemini = resolve; });
        throw new Error('private provider detail');
      },
      nvidia: async () => {
        order.push('nvidia');
        return 'Réponse de secours';
      },
    },
  });
  await service.initialize();

  const first = service.answer('première question');
  const concurrent = await service.answer('question concurrente');
  assert.deepEqual(concurrent, { status: 'busy' });
  await geminiStarted;
  assert.deepEqual(order, ['gemini']);
  releaseGemini();
  assert.deepEqual(await first, { status: 'answered', message: 'Réponse de secours' });
  assert.deepEqual(order, ['gemini', 'nvidia']);
  assert.equal(service.dailyUsed, 1);
  service.shutdown();
});

test('daily quota survives restart without persisting prompts or answers', async (t) => {
  const root = await makeDirectory();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const environment = { CHATBOT_DAILY_LIMIT: '2' };
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return 'answer not persisted';
  };
  const firstProcess = new ChatbotAIService(root, { environment, providers: { gemini: provider } });
  await firstProcess.initialize();
  assert.equal((await firstProcess.answer('private question one')).status, 'answered');
  assert.equal((await firstProcess.answer('private question two')).status, 'answered');
  assert.equal((await firstProcess.answer('private question three')).status, 'daily_limit');
  firstProcess.shutdown();

  const quotaPath = path.join(root, 'quota.json');
  const quota = JSON.parse(await readFile(quotaPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(quota).sort(), ['schemaVersion', 'used', 'utcDay']);
  assert.equal(quota.used, 2);
  assert.equal(JSON.stringify(quota).includes('private question'), false);
  assert.equal(JSON.stringify(quota).includes('answer not persisted'), false);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(quotaPath)).mode & 0o777, 0o600);

  const afterRestart = new ChatbotAIService(root, { environment, providers: { gemini: provider } });
  await afterRestart.initialize();
  assert.equal(afterRestart.dailyUsed, 2);
  assert.equal((await afterRestart.answer('another question')).status, 'daily_limit');
  assert.equal(providerCalls, 2);
  afterRestart.shutdown();
});

test('zero daily limit disables requests and replies are plain, bounded chat text', async (t) => {
  const root = await makeDirectory();
  t.after(async () => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const service = new ChatbotAIService(root, {
    environment: { CHATBOT_DAILY_LIMIT: '0' },
    providers: { gemini: async () => { calls += 1; return `§a${'x'.repeat(500)}`; } },
  });
  await service.initialize();
  assert.deepEqual(await service.answer('hello'), { status: 'daily_limit' });
  assert.equal(calls, 0);
  service.shutdown();
});
