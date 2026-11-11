import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITIES,
  DEFAULT_HARD_GATES,
  MUTATION_SCOPES,
  admitMutation,
  passesHardGates,
  scopePolicy,
} from 'autogenous';

const parent = {
  hash: 'g0',
  identity: 'radio-moe/mesh',
  constitution: 'c0',
  capability_ceiling: 'governed',
  hard_invariants: [{ name: 'tenant_isolation', holds: true }],
  lineage: [],
};

const mutation = (overrides = {}) => ({
  id: 'm1',
  parent_genome_hash: 'g0',
  scope: 'routing_budget',
  requested_authority: 'auto_reversible',
  applicability: { workloads: [], environments: [], jurisdictions: [] },
  preserved_invariants: [{ name: 'tenant_isolation', holds: true }],
  rollback_target: 'g0',
  expires_at: null,
  signature: null,
  ...overrides,
});

test('admits a reversible routing mutation', () => {
  assert.deepEqual(admitMutation(mutation(), parent, 0), { admissible: true });
});

test('rejects each structural violation with the Rust reason', () => {
  const cases = [
    [{ parent_genome_hash: 'other' }, 'parent_mismatch'],
    [{ scope: 'constitutional', requested_authority: 'constitutional' }, 'constitutional_scope'],
    [{ requested_authority: 'constitutional' }, 'authority_expansion'],
    [{ scope: 'application_code' }, 'authority_insufficient'],
    [{ preserved_invariants: [] }, 'invariant_regressed'],
    [{ rollback_target: null }, 'no_rollback'],
    [{ expires_at: 10 }, 'expired'],
  ];
  for (const [overrides, reason] of cases) {
    const result = admitMutation(mutation(overrides), parent, 10);
    assert.equal(result.admissible, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('requires an explicit integer clock and well-formed input', () => {
  assert.throws(() => admitMutation(mutation(), parent, 1.5), TypeError);
  assert.throws(() => admitMutation({ id: 'broken' }, parent, 0), /invalid mutation/);
});

test('scope policy matches AGL ordering', () => {
  assert.equal(AUTHORITIES.length, 5);
  assert.equal(MUTATION_SCOPES.length, 10);
  assert.deepEqual(scopePolicy('routing_budget'), {
    scope: 'routing_budget', autoPromotable: true, minAuthority: 'auto_reversible',
  });
  assert.deepEqual(scopePolicy('security_policy'), {
    scope: 'security_policy', autoPromotable: false, minAuthority: 'governed',
  });
  assert.throws(() => scopePolicy('nope'), /invalid scope/);
});

test('hard gates are a conjunction with ADR-392 defaults', () => {
  const fitness = {
    task_quality: 0.9, safety: 0.995, governance: 1, reliability: 1,
    p99_overhead_ms: 2, false_positive_rate: 0.001, regression_count: 0, rollback_verified: true,
  };
  assert.deepEqual(DEFAULT_HARD_GATES, {
    min_safety: 0.99, min_governance: 0.99, max_false_positive_rate: 0.005, max_p99_overhead_ms: 5,
  });
  assert.equal(passesHardGates(fitness), true);
  assert.equal(passesHardGates({ ...fitness, rollback_verified: false }), false);
  assert.equal(passesHardGates({ ...fitness, task_quality: 1, safety: 0.5 }), false);
  assert.equal(passesHardGates(fitness, { ...DEFAULT_HARD_GATES, min_safety: 0.999 }), false);
});
