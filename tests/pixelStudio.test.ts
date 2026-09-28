import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PIXEL_STUDIO_PALETTES,
  createEmptyPixelMatrix,
  createPixelStudioProject,
  fillPixelRegion,
  parsePixelMatrix,
  parsePixelStudioProject,
  resizePixelMatrix,
} from '../src/utils/pixelStudio.ts';
import { PixelStudioAIError, PixelStudioAIService } from '../src/pixelStudio/aiService.ts';

const ART_COLOR = '#B02E26';

function matrix(color = ART_COLOR): string[][] {
  return Array.from({ length: 16 }, () => Array<string>(16).fill(color));
}

function matrixResponse(color = ART_COLOR): string {
  return JSON.stringify({ matrix: matrix(color) });
}

function animationResponse(frameCount: number): string {
  return JSON.stringify({ frames: Array.from({ length: frameCount }, (_, index) => ({ matrix: matrix(index % 2 ? '#5CDBD5' : ART_COLOR) })) });
}

test('pixel matrix helpers resize crisply, fill only connected cells, and validate project exports', () => {
  const pixels = createEmptyPixelMatrix(16);
  pixels[0][0] = ART_COLOR;
  pixels[15][15] = '#5CDBD5';
  const enlarged = resizePixelMatrix(pixels, 32);
  assert.equal(enlarged[0][0], ART_COLOR);
  assert.equal(enlarged[1][1], ART_COLOR);
  assert.equal(enlarged[30][30], '#5CDBD5');
  assert.equal(enlarged[29][29], '');
  const reduced = resizePixelMatrix(enlarged, 16);
  assert.equal(reduced[0][0], ART_COLOR);
  assert.equal(reduced[15][15], '#5CDBD5');

  const region = createEmptyPixelMatrix(16);
  for (let y = 0; y < 16; y += 1) region[y][8] = '#1D1D21';
  const filled = fillPixelRegion(region, 0, 0, ART_COLOR);
  assert.equal(filled[0][0], ART_COLOR);
  assert.equal(filled[15][7], ART_COLOR);
  assert.equal(filled[0][9], '');
  assert.equal(filled[0][8], '#1D1D21');

  assert.deepEqual(parsePixelMatrix(matrix(), 16), matrix());
  assert.equal(parsePixelMatrix([['bad']], 16), null);
  const project = createPixelStudioProject();
  assert.equal(parsePixelStudioProject(JSON.parse(JSON.stringify(project)))?.gridSize, 16);
  assert.equal(parsePixelStudioProject({ ...project, gridSize: 128 }), null);
  assert.equal(parsePixelStudioProject({ ...project, paletteId: '__proto__' }), null);
  assert.equal(parsePixelStudioProject({ ...project, frames: [project.frames[0], project.frames[0]] }), null);
  assert.equal(PIXEL_STUDIO_PALETTES.minecraft.colors.includes('#5CDBD5'), true);
});

test('pixel generation calls NVIDIA NIM first and skips Gemini when it succeeds', async () => {
  const calls: string[] = [];
  const service = new PixelStudioAIService({
    environment: {},
    providers: {
      nvidia: async () => { calls.push('nvidia'); return matrixResponse(); },
      gemini: async () => { calls.push('gemini'); return matrixResponse('#5CDBD5'); },
    },
  });
  const result = await service.generateMatrix({ prompt: 'un cristal du Nether' });
  assert.deepEqual(calls, ['nvidia']);
  assert.equal(result.provider, 'nvidia');
  assert.equal(result.result[0][0], ART_COLOR);
  assert.deepEqual(service.getStatus(), {
    available: true,
    primaryAvailable: true,
    fallbackAvailable: true,
    fallbackOrder: ['NVIDIA NIM', 'Gemini'],
  });
});

test('invalid NVIDIA output falls back to Gemini and never returns provider errors', async () => {
  const calls: string[] = [];
  const service = new PixelStudioAIService({
    providers: {
      nvidia: async () => { calls.push('nvidia'); throw new Error('private NIM detail'); },
      gemini: async () => { calls.push('gemini'); return matrixResponse('#5CDBD5'); },
    },
  });
  const result = await service.generateMatrix({ prompt: 'une lanterne pixelisée' });
  assert.deepEqual(calls, ['nvidia', 'gemini']);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.result[0][0], '#5CDBD5');

  const unavailable = new PixelStudioAIService({
    providers: { nvidia: async () => { throw new Error('secret model error'); } },
  });
  await assert.rejects(
    unavailable.generateMatrix({ prompt: 'une pioche' }),
    (error: unknown) => error instanceof PixelStudioAIError
      && error.code === 'unavailable'
      && !error.message.includes('secret'),
  );
});

test('NVIDIA credentials remain server-side and its selected model can be configured', async () => {
  let requestBody = '';
  let authorization = '';
  const service = new PixelStudioAIService({
    environment: { NVIDIA_NIM_API_KEY: 'test-secret-key', PIXEL_STUDIO_NIM_MODEL: 'nvidia/example-model' },
    fetcher: async (_input, init) => {
      requestBody = String(init?.body ?? '');
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      return new Response(JSON.stringify({ choices: [{ message: { content: matrixResponse() } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await service.generateMatrix({ prompt: 'une étoile du Nether' });
  assert.equal(result.provider, 'nvidia');
  assert.equal(authorization, 'Bearer test-secret-key');
  assert.equal(JSON.parse(requestBody).model, 'nvidia/example-model');
  assert.equal(JSON.stringify(result).includes('test-secret-key'), false);
});

test('animation generation validates frames and supports a drawn base without a text prompt', async () => {
  let capturedPrompt = '';
  const service = new PixelStudioAIService({
    providers: {
      nvidia: async (_system, prompt) => { capturedPrompt = prompt; return animationResponse(3); },
    },
  });
  const result = await service.generateAnimation({
    prompt: '',
    animationType: 'shimmer',
    frameCount: 3,
    currentMatrix: matrix(),
  });
  assert.equal(result.provider, 'nvidia');
  assert.equal(result.result.length, 3);
  assert.match(capturedPrompt, /BASE SPRITE/);
  assert.equal(result.result[1][0][0], '#5CDBD5');

  await assert.rejects(
    service.generateAnimation({ prompt: '', animationType: 'shimmer', frameCount: 3 }),
    (error: unknown) => error instanceof PixelStudioAIError && error.code === 'invalid_request',
  );
});

test('generation rejects empty or oversized prompts before contacting providers', async () => {
  let calls = 0;
  const service = new PixelStudioAIService({ providers: { nvidia: async () => { calls += 1; return matrixResponse(); } } });
  await assert.rejects(service.generateMatrix({ prompt: '   ' }), (error: unknown) => error instanceof PixelStudioAIError && error.code === 'invalid_request');
  await assert.rejects(service.generateMatrix({ prompt: 'x'.repeat(601) }), (error: unknown) => error instanceof PixelStudioAIError && error.code === 'invalid_request');
  assert.equal(calls, 0);
});
