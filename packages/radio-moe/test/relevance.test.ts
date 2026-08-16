import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, bagCosine, RelevanceScorer } from '../src/relevance.js';
import type { AgentFrame } from '../src/agent-frame.js';

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
