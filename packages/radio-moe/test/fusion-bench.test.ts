//! Fusion-vs-best-single acceptance test (PIM ADR-401 V1 milestone #2).
//!
//! Asserts the honest three-part thesis the bench demonstrates (deterministic
//! corpus, so these are exact facts, not flaky thresholds):
//!   1. INDEPENDENT errors → fusion beats the strongest single expert.
//!   2. CORRELATED errors → naive-vote AND the mixture's source-dedup fusion are
//!      dragged BELOW best-single by a confidently-wrong correlated cluster
//!      (source-dedup is necessary but NOT sufficient).
//!   3. CORRELATED errors → LINEAGE-weighted fusion (effectiveSupport) recovers
//!      to ≥ best-single and beats naive-vote — independence must be measured by
//!      lineage, not just shared sourceIds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFusionBench } from '../examples/bench-fusion.js';
import { INDEPENDENT_CORPUS, CORRELATED_CORPUS } from '../examples/fusion-corpus.js';

test('INDEPENDENT errors: fusion beats the strongest single expert', () => {
  const r = runFusionBench(INDEPENDENT_CORPUS, 'independent');
  assert.ok(r.tasks >= 20, `corpus should have >=20 tasks, got ${r.tasks}`);
  // No single expert is dominant; fusion strictly exceeds the best of them.
  assert.ok(r.lineageMixture > r.bestSingle, `lineage fusion ${r.lineageMixture} !> best-single ${r.bestSingle}`);
  assert.ok(r.mixture > r.bestSingle, `coefficient mixture ${r.mixture} !> best-single ${r.bestSingle}`);
});

test('CORRELATED errors: naive-vote and source-dedup fusion are dragged below best-single', () => {
  const r = runFusionBench(CORRELATED_CORPUS, 'correlated');
  // A confidently-wrong correlated cluster defeats vote-counting AND the
  // mixture's sourceId de-dup (the single surviving cluster vote still outscores
  // the correct minority on quality/cost). This is the failure the guard closes.
  assert.ok(r.naiveVote < r.bestSingle, `naive-vote ${r.naiveVote} should be < best-single ${r.bestSingle}`);
  assert.ok(r.mixture <= r.bestSingle, `source-dedup mixture ${r.mixture} should be <= best-single ${r.bestSingle}`);
});

test('CORRELATED errors: lineage-weighted fusion recovers to >= best-single and beats naive-vote', () => {
  const r = runFusionBench(CORRELATED_CORPUS, 'correlated');
  assert.ok(r.lineageMixture >= r.bestSingle, `lineage fusion ${r.lineageMixture} should be >= best-single ${r.bestSingle}`);
  assert.ok(r.lineageMixture > r.naiveVote, `lineage fusion ${r.lineageMixture} should beat naive-vote ${r.naiveVote}`);
  // And it strictly improves on the source-dedup-only mixture in this regime.
  assert.ok(r.lineageMixture > r.mixture, `lineage fusion ${r.lineageMixture} should beat source-dedup ${r.mixture}`);
});
