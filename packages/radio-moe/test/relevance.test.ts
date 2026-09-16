import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, bagCosine, RelevanceScorer } from '../src/relevance.js';
import type { AgentFrame } from '../src/agent-frame.js';
import { ReferenceRelevanceScorer } from './helpers/relevance-reference.js';

function frame(agentId: string, value: string, step = 0): AgentFrame {
  return {
    requestId: 'r', agentId, step, kind: 'claim', value,
    confidence: 0.5, uncertainty: 0.5, dependencies: [], capabilityUsed: 'reasoning',
    evidenceHashes: [], cost: 0, signature: 'not-checked-here',
  };
}

test('tokenize + bagCosine basics', () => {
  const a = tokenize('Routing and authority must stay separate');
  assert.ok(a.has('routing') && a.has('authority') && !a.has('and'), 'stopwords dropped');
  assert.ok(Math.abs(bagCosine(a, a) - 1) < 1e-9, 'self-similarity = 1');
  assert.equal(bagCosine(a, tokenize('completely unrelated pastry recipes')), 0);
});

test('on-topic contributions outscore off-topic ones', () => {
  const s = new RelevanceScorer('why keep routing and authority separate in an agent mesh?');
  const onTopic = s.score(frame('a', 'separating routing from authority keeps the agent mesh safe'));
  const offTopic = s.score(frame('b', 'my favourite pastry recipe involves croissants and butter'));
  assert.ok(onTopic > 0.3, `on-topic should score high: ${onTopic}`);
  assert.ok(offTopic < 0.05, `off-topic should score near zero: ${offTopic}`);
  assert.ok(onTopic > offTopic * 5);
});

test('a near-verbatim echo of another agent is damped (lexical false-consensus)', () => {
  const s = new RelevanceScorer('why keep routing and authority separate in an agent mesh?');
  const original = s.score(frame('a', 'routing must stay separate from authority in the mesh'));
  const echo = s.score(frame('b', 'routing must stay separate from authority in the mesh'));
  assert.ok(echo < original * 0.5, `echo ${echo} must be damped vs original ${original}`);
  // A distinct on-topic angle keeps most of its score.
  const fresh = s.score(frame('c', 'authority tokens should be capability scoped and auditable in the mesh'));
  assert.ok(fresh > echo, 'novel on-topic beats the echo');
});

test('streamed deltas accumulate per agent instead of being punished for brevity', () => {
  const s = new RelevanceScorer('why keep routing and authority separate?');
  s.score(frame('a', 'routing ', 0));
  s.score(frame('a', 'and authority ', 1));
  const final = s.score(frame('a', 'must be separate', 2));
  assert.ok(final > 0.5, `accumulated stream should be strongly topical: ${final}`);
});

test('fold() moves the context with the live trajectory', () => {
  const s = new RelevanceScorer('diagnose the incident');
  const before = s.score(frame('x', 'the database connection pool is exhausted'));
  s.fold('the database connection pool is exhausted');
  const after = s.score(frame('y', 'increase the connection pool limit for the database'));
  assert.ok(after > before, 'follow-ups to folded context gain topicality');
});

function compare(scoring: RelevanceScorer, reference: ReferenceRelevanceScorer, f: AgentFrame): void {
  const actual = scoring.score(f);
  const expected = reference.score(f);
  assert.ok(Number.isFinite(actual), 'score must stay finite');
  assert.ok(Math.abs(actual - expected) <= 1e-12,
    `agent=${f.agentId} step=${f.step}: ${actual} != ${expected}`);
}

test('every chunk boundary agrees with full-history scoring', () => {
  const text = 'the there and android route ROUTING 12 123 __proto__ constructor Kelvin İSTANBUL ΟΣ 😀 e\u0301 café\r\n';
  for (let split = 0; split <= text.length; split++) {
    const scoring = new RelevanceScorer(text);
    const reference = new ReferenceRelevanceScorer(text);
    compare(scoring, reference, frame('peer', text));
    compare(scoring, reference, frame('__proto__', text.slice(0, split)));
    compare(scoring, reference, frame('__proto__', ''));
    compare(scoring, reference, frame('__proto__', text.slice(split), 1));
    scoring.fold('router'); reference.fold('router');
    scoring.fold('authority'); reference.fold('authority');
    compare(scoring, reference, { ...frame('constructor', ''), value: { route: 'authority', n: 12 } });
    compare(scoring, reference, { ...frame('constructor', ''), value: null });
  }
});

test('seeded interleaved streams and folds preserve the reference scores', () => {
  const scoring = new RelevanceScorer('routing authority database token rollback');
  const reference = new ReferenceRelevanceScorer('routing authority database token rollback');
  const fragments = ['rou', 'ting', 'the', 're', ' and ', 'authority', ' database ', '\n', '123', '😀', 'İ', 'K', '-', 'x', '', ' rollback '];
  let seed = 0x20260916;
  const next = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 5000; step++) {
    const agent = `agent${next() % 19}`;
    const text = fragments[next() % fragments.length]!;
    compare(scoring, reference, frame(agent, text, step));
    if (step % 31 === 0) { scoring.fold(text); reference.fold(text); }
  }
});

test('a long delimiter-free token and repeated tokens preserve prefix semantics', () => {
  const scoring = new RelevanceScorer('aaa authority');
  const reference = new ReferenceRelevanceScorer('aaa authority');
  for (let step = 0; step < 100; step++) {
    compare(scoring, reference, frame('long', 'a'.repeat(100), step));
    compare(scoring, reference, frame('repeat', 'authority authority ', step));
  }
});


test('structured payloads and serialization failures preserve scorer state', () => {
  const scoring = new RelevanceScorer('undefined authority route null');
  const reference = new ReferenceRelevanceScorer('undefined authority route null');
  for (const value of [undefined, null, 123, true, ['route'], { authority: 'route' }, Symbol('route'), () => 0]) {
    compare(scoring, reference, { ...frame('a', ''), value });
  }
  const circular: unknown[] = []; circular.push(circular);
  for (const value of [circular, 1n]) {
    const f = { ...frame('a', ''), value };
    assert.throws(() => scoring.score(f), TypeError);
    assert.throws(() => reference.score(f), TypeError);
    compare(scoring, reference, frame('a', ' authority'));
  }
});
