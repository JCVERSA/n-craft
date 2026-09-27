import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTunnelProvider } from '../src/tunnelProvider.ts';

test('defaults to Localtonet and keeps Playit as an explicit provider', () => {
  const previous = process.env.TUNNEL_PROVIDER;
  delete process.env.TUNNEL_PROVIDER;
  try {
    assert.equal(resolveTunnelProvider(), 'localtonet');
    assert.equal(resolveTunnelProvider(''), 'localtonet');
    assert.equal(resolveTunnelProvider('playit'), 'playit');
    assert.equal(resolveTunnelProvider(' PLAYIT '), 'playit');
    assert.equal(resolveTunnelProvider('unknown-provider'), 'localtonet');
  } finally {
    if (previous === undefined) delete process.env.TUNNEL_PROVIDER;
    else process.env.TUNNEL_PROVIDER = previous;
  }
});
