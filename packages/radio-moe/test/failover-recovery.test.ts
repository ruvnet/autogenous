//! Failover recovery acceptance (PIM ADR-401 V1 #1 / cond 3; ADR-402 cond 2):
//! lose ~30% of peers incl. the mixer, recover within 5 s, no lost authorized
//! state. Asserts the measured recovery path stays far under budget and the
//! signed checkpoint chain continues unbroken.
//!
//! Scope note: this measures the PROTOCOL recovery cost (fenced grant sign+verify
//! → shadow takeover → resumed envelope sign+verify), not network failure-
//! detection latency — the 5 s budget leaves ample room for the latter.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runFailoverRecovery } from '../examples/bench-failover.js';

test('recovers from 30% peer loss (incl. mixer) well within the 5s budget, no lost state', () => {
  const r = runFailoverRecovery({ peers: 10, envelopesBeforeLoss: 20, iterations: 30 });
  assert.equal(r.lost, 3, '30% of 10 peers = 3 lost');
  assert.ok(r.survivors >= 1, 'at least one fully-replicated survivor takes over');
  assert.equal(r.stateContinuous, true, 'the exact signed checkpoint chain must continue after takeover');
  assert.ok(r.recoveredWithinBudget, `max recovery ${r.recoveryMs.max}ms must be < ${r.budgetMs}ms`);
  // Generous ceiling so the assertion is about the budget, not host jitter.
  assert.ok(r.recoveryMs.max < 100, `protocol recovery ${r.recoveryMs.max}ms should be well under 100ms`);
});

test('scales to a larger mesh (20 peers, lose 6)', () => {
  const r = runFailoverRecovery({ peers: 20, envelopesBeforeLoss: 10, iterations: 20 });
  assert.equal(r.lost, 6);
  assert.equal(r.stateContinuous, true);
  assert.ok(r.recoveredWithinBudget);
});
