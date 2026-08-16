import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerIdentity } from '../src/transport.js';
import { verifyFrame, type AgentFrame } from '../src/agent-frame.js';
import {
  HttpStreamingExpert,
  openaiSseParser,
  geminiSseParser,
  openRouterExpert,
  type FetchLike,
} from '../src/http-experts.js';

function sseFetch(lines: string[]): FetchLike {
  const enc = new TextEncoder();
  const payload = lines.map((l) => `${l}\n`).join('');
  return async () => ({
    ok: true,
    status: 200,
    text: async () => '',
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(payload));
        c.close();
      },
    }),
  });
}

test('openaiSseParser maps deltas + finish to frames', () => {
  assert.deepEqual(
    openaiSseParser({ choices: [{ delta: { content: 'hi' } }] }),
    [{ kind: 'claim', value: 'hi', confidence: 0.45, uncertainty: 0.55 }],
  );
  const fin = openaiSseParser({ choices: [{ finish_reason: 'stop' }], usage: { total_tokens: 7 } });
  assert.equal(fin[0]!.kind, 'plan');
  assert.equal(fin[0]!.cost, 7);
  assert.deepEqual(openaiSseParser({ choices: [{ delta: {} }] }), []);
});

test('geminiSseParser maps candidate parts to claim frames', () => {
  const out = geminiSseParser({ candidates: [{ content: { parts: [{ text: 'abc' }] } }] });
  assert.equal(out[0]!.value, 'abc');
});

test('HttpStreamingExpert streams signed frames from a fake SSE endpoint (offline)', async () => {
  const id = PeerIdentity.generate();
  const expert = openRouterExpert('router', id, [1, 0], {
    model: 'test/model',
    fetchImpl: sseFetch([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":5}}',
      'data: [DONE]',
    ]),
  });

  const frames: AgentFrame[] = [];
  for await (const f of expert.run('say hello', 'req-http-1')) frames.push(f);

  assert.equal(frames.length, 3, 'two deltas + one finish frame');
  assert.deepEqual(frames.map((f) => f.step), [0, 1, 2]);
  assert.equal(frames[0]!.value, 'Hello');
  assert.equal(frames[1]!.value, ' world');
  assert.equal(frames[2]!.kind, 'plan');
  assert.equal(frames[2]!.cost, 5);
  assert.ok(
    frames.every((f) => f.requestId === 'req-http-1' && verifyFrame(f, id.publicKeyDer.toString('hex'))),
    'every frame is signed by the peer identity',
  );
});

test('a non-ok provider response throws with the status', async () => {
  const id = PeerIdentity.generate();
  const expert = new HttpStreamingExpert({
    agentId: 'x',
    identity: id,
    capability: [1],
    endpoint: 'http://unused',
    headers: () => ({}),
    body: () => ({}),
    parser: openaiSseParser,
    hasCredentials: () => true,
    fetchImpl: async () => ({ ok: false, status: 429, body: null, text: async () => 'rate limited' }),
  });
  await assert.rejects(async () => {
    for await (const _ of expert.run('p', 'r')) void _;
  }, /HTTP 429/);
});

test('hasCredentials reflects the environment (no-key fallback signal)', () => {
  const id = PeerIdentity.generate();
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(openRouterExpert('r', id, [1], { model: 'm' }).hasCredentials(), false);
  process.env.OPENROUTER_API_KEY = 'sk-test';
  assert.equal(openRouterExpert('r', id, [1], { model: 'm' }).hasCredentials(), true);
  if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = prev;
});
