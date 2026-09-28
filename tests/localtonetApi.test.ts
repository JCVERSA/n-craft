import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBedrockTunnel, findBedrockUdpTunnel } from '../src/localtonet/localtonetApi.ts';

test('finds the configured Bedrock UDP endpoint and accepts Localtonet enum values', () => {
  const tunnel = findBedrockUdpTunnel([
    {
      id: 'http-tunnel',
      protocolType: 'HTTP',
      clientPort: 19132,
      url: 'https://not-bedrock.localtonet.com',
      serverPort: 443,
      connectionStatus: true,
    },
    {
      id: 'other-port',
      protocolType: 2,
      clientPort: 19133,
      url: '198.51.100.8:31001',
      connectionStatus: true,
    },
    {
      id: 123,
      title: 'Bedrock',
      protocolType: 4,
      clientPort: '19132',
      url: 'udp://bedrock.example.net:32456',
      connectionStatus: true,
    },
  ]);

  assert.deepEqual(tunnel, {
    address: 'bedrock.example.net:32456',
    connected: true,
    id: '123',
    title: 'Bedrock',
  });
});

test('uses the server port when Localtonet returns a host without a port', () => {
  const tunnel = findBedrockUdpTunnel({ tunnels: [{
    protocolType: 'UDP',
    clientPort: 19132,
    serverDomain: 'bedrock.example.net',
    serverPort: 27345,
    connectionStatus: false,
  }] });

  assert.equal(tunnel?.address, 'bedrock.example.net:27345');
  assert.equal(tunnel?.connected, false);
});

test('formats a bare IPv6 server address with the API server port', () => {
  const tunnel = findBedrockUdpTunnel([{
    protocolType: 2,
    clientPort: 19132,
    serverIp: '2001:db8::1',
    serverPort: 30123,
    connectionStatus: true,
  }]);

  assert.equal(tunnel?.address, '[2001:db8::1]:30123');
});

test('does not guess an endpoint when multiple Bedrock UDP tunnels are configured', () => {
  assert.throws(() => findBedrockUdpTunnel([
    { protocolType: 2, clientPort: 19132, url: 'first.example.net:10001', connectionStatus: false },
    { protocolType: 'UDP', clientPort: 19132, url: 'second.example.net:10002', connectionStatus: false },
  ]), /Plusieurs tunnels UDP/);
});

test('requests Localtonet API v2 without returning credentials', async () => {
  const authToken = 'token/that-must-stay-private';
  const apiKey = 'api-key-that-must-stay-private';
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const tunnel = await fetchBedrockTunnel({
    authToken,
    apiKey,
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify([{
        protocolType: 2,
        clientPort: 19132,
        serverDomain: 'bedrock.example.net',
        serverPort: 30001,
        connectionStatus: true,
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(requestUrl, 'https://localtonet.com/api/v2/auth-tokens/token%2Fthat-must-stay-private/tunnels');
  assert.equal(requestInit?.method, 'GET', 'tunnel discovery is read-only');
  assert.equal(new Headers(requestInit?.headers).get('Authorization'), `Bearer ${apiKey}`);
  assert.equal(tunnel?.address, 'bedrock.example.net:30001');
  assert.equal(JSON.stringify(tunnel).includes(authToken), false);
  assert.equal(JSON.stringify(tunnel).includes(apiKey), false);
});

test('sanitizes Localtonet authorization errors', async () => {
  await assert.rejects(fetchBedrockTunnel({
    authToken: 'private-auth-token',
    apiKey: 'private-api-key',
    fetchImpl: async () => new Response('unauthorized', { status: 401 }),
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /LOCALTONET_API_KEY/);
    assert.equal(error.message.includes('private-auth-token'), false);
    assert.equal(error.message.includes('private-api-key'), false);
    return true;
  });
});
