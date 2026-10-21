import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { NovaRelayServer } from '../src/relay/relay-server.js';
import { NovaClient } from '../src/client/relay-client.js';
import { hash } from '../src/pools/pool-protocol.js';

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

const close = (server: http.Server) => new Promise<void>(resolve => {
  server.closeAllConnections();
  server.close(() => resolve());
});

test('NovaClient interacts end-to-end with NovaRelayServer for streaming and non-streaming inference', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'client-integration-'));
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  const upstreamOrigin = await listen(upstream);

  wss.on('connection', socket => {
    socket.on('message', data => {
      // Simulate real OpenAI response streaming over WS
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'Inference response token 1. '
      }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'Inference response token 2.'
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 }
        }
      }));
    });
  });

  const apiKey = 'test_key_' + randomBytes(16).toString('hex');
  const server = new NovaRelayServer({
    host: '127.0.0.1',
    port: 0,
    apiKeys: [apiKey],
    adminApiKeys: [hash('admin-' + apiKey)],
    wsEndpoint: upstreamOrigin.replace('http:', 'ws:'),
    assignedShardId: 'shard_client_test',
    assignedShard: { id: 'shard_client_test', accessToken: 'token_client', accountId: 'acc_client' },
    capabilityDiscovery: async () => ['gpt-4o', 'fixture'],
    registryEnabled: false,
    discoverHostCredentials: false,
    stateSnapshotPath: path.join(directory, 'state.json')
  });

  try {
    await server.start();
    const relayOrigin = `http://127.0.0.1:${server.listeningPort()}`;

    const client = new NovaClient({
      baseUrl: relayOrigin,
      apiKey: apiKey,
      tenant: 'tenant_engineering'
    });

    // 1. Test streaming inference via client.chatStream()
    const chunks: string[] = [];
    for await (const chunk of client.chatStream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Stream test' }],
      idempotencyKey: randomUUID()
    })) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        chunks.push(delta);
      }
    }

    const fullContent = chunks.join('');
    assert.match(fullContent, /Inference response token 1/);
    assert.match(fullContent, /Inference response token 2/);

    // 2. Test model listing
    const models = await client.listModels();
    assert.ok(Array.isArray(models));
  } finally {
    await server.stop();
    wss.close();
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});
