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

test('Relay server rejects unauthenticated requests and enforces authorization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-auth-test-'));
  const apiKey = 'test_key_' + randomBytes(16).toString('hex');
  const server = new NovaRelayServer({
    host: '127.0.0.1',
    port: 0,
    apiKeys: [apiKey],
    adminApiKeys: [hash('admin-' + apiKey)],
    registryEnabled: false,
    discoverHostCredentials: false,
    stateSnapshotPath: path.join(directory, 'state.json')
  });

  try {
    await server.start();
    const origin = `http://127.0.0.1:${server.listeningPort()}`;

    // 1. Missing Authorization header
    const unauth = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(unauth.status, 401);
    const unauthJson = await unauth.json();
    assert.equal(unauthJson.error.code, 'unauthorized');

    // 2. Invalid Bearer key
    const invalidAuth = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer wrong_key_00000000000000000000000000000000',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(invalidAuth.status, 401);

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, 'ok');
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Relay server routes streaming chat completion through upstream WebSocket', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-stream-test-'));
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  const upstreamOrigin = await listen(upstream);

  let messageReceived = false;
  wss.on('connection', socket => {
    socket.on('message', data => {
      messageReceived = true;
      // Emit synthetic streaming responses matching OpenAI / Codex protocol
      socket.send(JSON.stringify({
        type: 'response.output_item.added',
        item: { id: 'msg_1', role: 'assistant' }
      }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'Hello from isolated inference relay!'
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
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
    assignedShardId: 'shard_alpha',
    assignedShard: { id: 'shard_alpha', accessToken: 'token_alpha', accountId: 'acc_alpha' },
    capabilityDiscovery: async () => ['gpt-4o', 'fixture'],
    registryEnabled: false,
    discoverHostCredentials: false,
    stateSnapshotPath: path.join(directory, 'state.json')
  });

  try {
    await server.start();
    const origin = `http://127.0.0.1:${server.listeningPort()}`;

    const res = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID()
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Say hello' }],
        stream: true
      })
    });

    assert.equal(res.status, 202);
    const job = await res.json();
    assert.equal(job.object, 'chat.completion.job');
    assert.ok(job.streamUrl);

    const streamRes = await fetch(`${origin}${job.streamUrl}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const text = await streamRes.text();
    assert.match(text, /data: /);
    assert.match(text, /Hello from isolated inference relay!/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(messageReceived, true);
  } finally {
    await server.stop();
    wss.close();
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});

test('Relay server preserves idempotency and returns job status', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-job-test-'));
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  const upstreamOrigin = await listen(upstream);

  wss.on('connection', socket => {
    socket.on('message', () => {
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
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
    assignedShardId: 'shard_beta',
    assignedShard: { id: 'shard_beta', accessToken: 'token_beta', accountId: 'acc_beta' },
    capabilityDiscovery: async () => ['gpt-4o', 'fixture'],
    registryEnabled: false,
    discoverHostCredentials: false,
    stateSnapshotPath: path.join(directory, 'state.json')
  });

  try {
    await server.start();
    const origin = `http://127.0.0.1:${server.listeningPort()}`;
    const idempotencyKey = randomUUID();

    // 1. Submit request
    const post = () => fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Testing job status' }]
      })
    });

    const res1 = await post();
    assert([200, 202].includes(res1.status));
    const data1 = await res1.json();
    assert.ok(data1.id);

    // 2. Query job status
    const jobRes = await fetch(`${origin}/v1/jobs/${data1.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    assert.equal(jobRes.status, 200);
    const job = await jobRes.json();
    assert.equal(job.id, data1.id);
  } finally {
    await server.stop();
    wss.close();
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});
