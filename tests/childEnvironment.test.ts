import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChildEnvironment } from '../src/childEnvironment.ts';

test('provider and other credential variables are never inherited by child processes', () => {
  const environment = buildChildEnvironment({ GEMINI_API_KEY: 'override-fake' }, {
    PATH: '/usr/bin',
    PORT: '3000',
    LD_LIBRARY_PATH: '/opt/runtime',
    GEMINI_API_KEY: 'fake-gemini-key',
    NVIDIA_NIM_API_KEY: 'fake-nvidia-key',
    LOCALTONET_AUTH_TOKEN: 'fake-tunnel-token',
    PANEL_TOKEN: 'fake-panel-token',
  });
  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    PORT: '3000',
    LD_LIBRARY_PATH: '/opt/runtime',
  });
});
