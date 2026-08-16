import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerIdentity } from '../src/transport.js';
import { canonicalBytes, signFrame, verifyFrame, evidenceHash } from '../src/agent-frame.js';
import {
  CommandStreamingExpert,
  claudeStreamParser,
  codexStreamParser,
  endlessMixLoop,
  type EventParser,
} from '../src/streaming-experts.js';
import type { AgentFrame } from '../src/agent-frame.js';

// A deterministic fake streaming backend: `node -e` prints fixture JSONL.
function fakeStreamCommand(events: unknown[]): { command: string; args: string[] } {
  const script = `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));`;
  return { command: process.execPath, args: ['-e', script] };
}
const fakeParser: EventParser = (event) => {
  const e = event as Record<string, unknown>;
  if (typeof e.delta === 'string') return [{ kind: 'claim', value: e.delta }];
  if (e.done) return [{ kind: 'claim', value: e.text, confidence: 0.9, cost: 0.001 }];
  return [];
};

test('canonical signing binds the frame; tampering breaks it; prototype keys rejected', () => {
  const id = PeerIdentity.generate();
  const frame = signFrame(id, {
    requestId: 'r1', agentId: 'a', step: 0, kind: 'claim', value: 'hello',
    confidence: 0.6, uncertainty: 0.3, dependencies: [], capabilityUsed: 'reasoning',
    evidenceHashes: [evidenceHash('some evidence')], cost: 0,
  });
  assert.ok(verifyFrame(frame, id.publicKeyDer.toString('hex')), 'honest frame verifies');
  const tampered: AgentFrame = { ...frame, value: 'goodbye' };
  assert.equal(verifyFrame(tampered, id.publicKeyDer.toString('hex')), false, 'tamper breaks sig');
  // canonical serialization refuses prototype-pollution keys.
  assert.throws(() => canonicalBytes({ ['__proto__']: { polluted: true } }), /forbidden key/);
});

test('canonical bytes are key-order independent', () => {
  const a = canonicalBytes({ b: 1, a: 2, nested: { y: 1, x: 2 } });
  const b = canonicalBytes({ nested: { x: 2, y: 1 }, a: 2, b: 1 });
  assert.equal(a.toString(), b.toString());
});

test('CommandStreamingExpert streams signed, monotonically-stepped frames', async () => {
  const id = PeerIdentity.generate();
  const expert = new CommandStreamingExpert(
    'stub', id, [1, 0, 0],
    fakeStreamCommand([{ delta: 'The ' }, { delta: 'answer ' }, { delta: 'is 42.' }, { done: true, text: 'The answer is 42.' }]),
    fakeParser,
  );
  const frames: AgentFrame[] = [];
  for await (const f of expert.run('q', 'req-1')) frames.push(f);

  assert.equal(frames.length, 4);
  assert.deepEqual(frames.map((f) => f.step), [0, 1, 2, 3], 'monotonic per-agent step');
  assert.ok(frames.every((f) => f.requestId === 'req-1' && f.agentId === 'stub'));
  assert.ok(frames.every((f) => verifyFrame(f, id.publicKeyDer.toString('hex'))), 'all frames signed');
  assert.equal(frames[3]!.value, 'The answer is 42.');
  assert.ok(frames[3]!.cost > 0, 'final frame carries metered cost');
});

test('cancellation stops the stream and cleans up the child', async () => {
  const id = PeerIdentity.generate();
  // A fake that emits two lines then blocks forever.
  const spec = { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({delta:"a"}));console.log(JSON.stringify({delta:"b"}));setInterval(()=>{},1e9);'] };
  const expert = new CommandStreamingExpert('slow', id, [1], spec, fakeParser);
  const got: AgentFrame[] = [];
  for await (const f of expert.run('q', 'req-2')) {
    got.push(f);
    if (got.length === 1) break; // breaking the loop triggers finally → child.kill
  }
  assert.equal(got.length, 1, 'consumer broke after one frame without hanging');
});

test('endlessMixLoop folds frames from multiple experts concurrently', async () => {
  const id = PeerIdentity.generate();
  const e1 = new CommandStreamingExpert('e1', id, [1, 0], fakeStreamCommand([{ delta: 'x' }, { done: true, text: 'x' }]), fakeParser);
  const e2 = new CommandStreamingExpert('e2', id, [0, 1], fakeStreamCommand([{ delta: 'y' }, { done: true, text: 'y' }]), fakeParser);
  const folded: AgentFrame[] = [];
  const n = await endlessMixLoop([e1, e2], 'q', 'req-3', (f) => folded.push(f));
  assert.equal(n, 4);
  assert.ok(folded.some((f) => f.agentId === 'e1') && folded.some((f) => f.agentId === 'e2'));
});

test('claude + codex parsers map real event shapes to claim frames', () => {
  // Claude stream-json: partial text delta + terminal result.
  const claudeDelta = claudeStreamParser({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } });
  assert.deepEqual(claudeDelta, [{ kind: 'claim', value: 'hi', confidence: 0.4, uncertainty: 0.6 }]);
  const claudeResult = claudeStreamParser({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.002 });
  assert.equal(claudeResult[0]!.value, 'done');
  assert.equal(claudeResult[0]!.cost, 0.002);
  assert.deepEqual(claudeStreamParser({ type: 'system', subtype: 'init' }), [], 'init ignored');

  // Codex JSONL: a text delta event.
  const codexDelta = codexStreamParser({ type: 'item.delta', msg: { delta: 'tok' } });
  assert.equal(codexDelta[0]!.value, 'tok');
});
