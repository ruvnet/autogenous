//! Sensor false-alert fusion acceptance (ADR-402 cond 3): corroboration-fusion
//! cuts the wired-fleet false-alert rate by >=50% without losing detection.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runFalseAlertBench } from '../examples/bench-false-alert.js';

test('corroborated fusion reduces false alerts >=50% vs the no-fusion (any-sensor) baseline', () => {
  const r = runFalseAlertBench();
  assert.ok(r.fusedFalseAlert < r.unionFalseAlert, 'fusion must beat the any-sensor union on false alerts');
  assert.ok(r.meetsHalfReduction, `reduction ${(r.reductionVsUnion * 100).toFixed(1)}% must be >= 50%`);
  assert.equal(r.detectionRetained, true, 'fusion must not lose real-event detection');
});

test('a stricter corroboration quorum cuts false alerts at least as hard', () => {
  const lenient = runFalseAlertBench(2.0);
  const strict = runFalseAlertBench(3.0);
  assert.ok(strict.fusedFalseAlert <= lenient.fusedFalseAlert, 'more corroboration should not raise false alerts');
});
