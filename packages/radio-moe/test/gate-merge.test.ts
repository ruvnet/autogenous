import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, softmax } from '../src/capability.js';
import { Gate } from '../src/gate.js';
import { mixLogits, raceTextExperts, IncompatibleVocabError } from '../src/merge.js';
import type { Chunk, ExpertAdvert, LogitFrame, TextFrame } from '../src/types.js';

test('cosine + softmax basics', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0, 'length mismatch → 0');
  const w = softmax([2, 1, 0], 1);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(w[0]! > w[1]! && w[1]! > w[2]!);
});

test('gate routes top-k of the requested kind, weights normalized', () => {
  const gate = new Gate({ topK: 2, tau: 0.5 });
  const mk = (id: string, cap: number[], kind: 'logit' | 'text'): ExpertAdvert => ({
    peerId: 'p', expertId: id, kind, capability: cap,
    ...(kind === 'logit' ? { vocabId: 'v1', vocabSize: 3 } : {}),
  });
  gate.register(mk('math', [1, 0, 0], 'logit'));
  gate.register(mk('code', [0, 1, 0], 'logit'));
  gate.register(mk('prose', [0, 0, 1], 'text')); // different kind — must be excluded

  const chunk: Chunk = { streamId: 's', seq: 0, features: [0.9, 0.1, 0] };
  const d = gate.route(chunk, 'logit');
  assert.equal(d.kind, 'logit');
  assert.equal(d.routed.length, 2, 'topK=2 logit experts');
  assert.equal(d.routed[0]!.expertId, 'math', 'best capability first');
  assert.ok(!d.routed.some((r) => r.expertId === 'prose'), 'text expert excluded');
  assert.ok(Math.abs(d.routed.reduce((a, r) => a + r.weight, 0) - 1) < 1e-9);
});

test('logit routing refuses to cross tokenizers', () => {
  const gate = new Gate({ topK: 3, tau: 1 });
  gate.register({ peerId: 'p', expertId: 'a', kind: 'logit', capability: [1, 0], vocabId: 'v1', vocabSize: 2 });
  gate.register({ peerId: 'p', expertId: 'b', kind: 'logit', capability: [0.9, 0.1], vocabId: 'v2', vocabSize: 2 });
  const d = gate.route({ streamId: 's', seq: 0, features: [1, 0] }, 'logit');
  assert.deepEqual(d.routed.map((r) => r.expertId), ['a'], 'only the top vocab survives');
});

test('mixLogits is a true weighted sum with renormalization', () => {
  const frames: LogitFrame[] = [
    { kind: 'logit', chunkId: 'c', expertId: 'a', peerId: 'p', position: 0, vocabId: 'v', logits: [1, 0, 0], final: true },
    { kind: 'logit', chunkId: 'c', expertId: 'b', peerId: 'p', position: 0, vocabId: 'v', logits: [0, 4, 0], final: true },
  ];
  const weights = new Map([['a', 0.25], ['b', 0.75]]);
  const mixed = mixLogits(frames, weights);
  assert.deepEqual(mixed.logits, [0.25, 3, 0]); // 0.25*1, 0.75*4
  assert.equal(mixed.argmax, 1);
  // Only 'a' present → renormalized to weight 1.
  const solo = mixLogits([frames[0]!], weights);
  assert.deepEqual(solo.logits, [1, 0, 0]);
});

test('mixLogits rejects incompatible vocab sizes', () => {
  const frames: LogitFrame[] = [
    { kind: 'logit', chunkId: 'c', expertId: 'a', peerId: 'p', position: 0, vocabId: 'v', logits: [1, 0], final: true },
    { kind: 'logit', chunkId: 'c', expertId: 'b', peerId: 'p', position: 0, vocabId: 'v', logits: [1, 0, 0], final: true },
  ];
  assert.throws(() => mixLogits(frames, new Map([['a', 0.5], ['b', 0.5]])), IncompatibleVocabError);
});

test('raceTextExperts ranks by weight and is labelled an ensemble', () => {
  const finals: TextFrame[] = [
    { kind: 'text', chunkId: 'c', expertId: 'x', peerId: 'p', seq: 1, tokens: 'x-answer', final: true },
    { kind: 'text', chunkId: 'c', expertId: 'y', peerId: 'p', seq: 1, tokens: 'y-answer', final: true },
  ];
  const routed = [
    { expertId: 'x', peerId: 'p', score: 0.2, weight: 0.3 },
    { expertId: 'y', peerId: 'p', score: 0.8, weight: 0.7 },
  ];
  const out = raceTextExperts(routed, finals);
  assert.equal(out.regime, 'text-ensemble');
  assert.equal(out.winner.expertId, 'y', 'highest weight wins');
  assert.equal(out.ranked.length, 2);
});
