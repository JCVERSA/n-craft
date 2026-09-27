import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTunnelProvider } from '../src/tunnelProvider.ts';

test('defaults to Portwarp and keeps Localtonet and Playit as explicit alternatives', () => {
  const previous = process.env.TUNNEL_PROVIDER;
  delete process.env.TUNNEL_PROVIDER;
  try {
    assert.equal(resolveTunnelProvider(), 'portwarp');
    assert.equal(resolveTunnelProvider(''), 'portwarp');
    assert.equal(resolveTunnelProvider('portwarp'), 'portwarp');
    assert.equal(resolveTunnelProvider('localtonet'), 'localtonet');
    assert.equal(resolveTunnelProvider(' LOCALTONET '), 'localtonet');
    assert.equal(resolveTunnelProvider('playit'), 'playit');
    assert.equal(resolveTunnelProvider(' PLAYIT '), 'playit');
    assert.equal(resolveTunnelProvider('unknown-provider'), 'portwarp');
  } finally {
    if (previous === undefined) delete process.env.TUNNEL_PROVIDER;
    else process.env.TUNNEL_PROVIDER = previous;
  }
});
