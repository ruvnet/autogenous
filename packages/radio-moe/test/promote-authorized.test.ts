//! The ONE governed-promotion predicate (ADR-401 Decision 3):
//! Promote = Better ∧ Safe ∧ Authorized ∧ Reversible. No path may promote on
//! three of four — each conjunct is independently blocking.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteAuthorized, promotable, PROMOTION_MARGIN, type Fitness } from '../src/index.js';

const champion: Fitness = { separation: 1.0, familyStack: 1, diversePair: 2, topicRatio: 5, hardGatesPass: true };
// A candidate that clears Better (beats champion by the margin) and Safe.
const goodCandidate: Fitness = { ...champion, separation: 1.0 + PROMOTION_MARGIN + 0.01 };

test('promotes only when all four conjuncts hold', () => {
  const d = promoteAuthorized(goodCandidate, champion, { authorized: true, reversible: true });
  assert.deepEqual(
    { better: d.better, safe: d.safe, authorized: d.authorized, reversible: d.reversible, promote: d.promote },
    { better: true, safe: true, authorized: true, reversible: true, promote: true },
  );
});

test('each conjunct is independently blocking (three-of-four never promotes)', () => {
  // ¬Better: fails the margin.
  assert.equal(promoteAuthorized({ ...champion, separation: champion.separation }, champion, { authorized: true, reversible: true }).promote, false);
  // ¬Safe: hard gates fail.
  assert.equal(promoteAuthorized({ ...goodCandidate, hardGatesPass: false }, champion, { authorized: true, reversible: true }).promote, false);
  // ¬Authorized.
  assert.equal(promoteAuthorized(goodCandidate, champion, { authorized: false, reversible: true }).promote, false);
  // ¬Reversible.
  assert.equal(promoteAuthorized(goodCandidate, champion, { authorized: true, reversible: false }).promote, false);
});

test('the verdict pinpoints which conjunct blocked', () => {
  const d = promoteAuthorized(goodCandidate, champion, { authorized: false, reversible: true });
  assert.equal(d.better, true);
  assert.equal(d.safe, true);
  assert.equal(d.authorized, false);
  assert.equal(d.promote, false);
});

test('promotable is exactly the Better∧Safe core of promoteAuthorized', () => {
  for (const cand of [goodCandidate, { ...goodCandidate, hardGatesPass: false }, { ...champion, separation: champion.separation }]) {
    const core = promoteAuthorized(cand, champion, { authorized: true, reversible: true });
    assert.equal(promotable(cand, champion), core.better && core.safe);
  }
});
