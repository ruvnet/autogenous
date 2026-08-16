//! Unit tests for lineage-weighted fusion (src/lineage-decision.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineageWeightedWinner, lineageRegistry } from '../src/lineage-decision.js';
import type { MixtureSnapshot } from '../src/mixture.js';
import type { ModelLineage } from '../src/lineage-independence.js';

/** Minimal snapshot carrying only the fields lineageWeightedWinner reads. */
function snapshotOf(
  support: { agentId: string; claimId: string; sourceIds: string[] }[],
  netWeight: Record<string, number>,
): MixtureSnapshot {
  return {
    audit: support.map((s) => ({ relation: 'support', ...s })),
    claims: Object.entries(netWeight).map(([claimId, nw]) => ({ claimId, netWeight: nw })),
  } as unknown as MixtureSnapshot;
}

const REGISTRY: Record<string, ModelLineage> = {
  'llama-s': { provider: 'meta', arch: 'llama', sizeClass: 'S', modelId: 'llama-s' },
  'llama-m': { provider: 'meta', arch: 'llama', sizeClass: 'M', modelId: 'llama-m' },
  'llama-l': { provider: 'meta', arch: 'llama', sizeClass: 'L', modelId: 'llama-l' },
  'gemini': { provider: 'google', arch: 'gemini', sizeClass: 'XL', modelId: 'gemini' },
  'claude': { provider: 'anthropic', arch: 'claude', sizeClass: 'XL', modelId: 'claude' },
};

test('a correlated 3-model cluster loses to an independent 2-model minority', () => {
  // Wrong claim W has THREE meta/llama supporters (shared pool); correct claim C
  // has TWO independent supporters. Even though W has more raw votes AND a higher
  // coefficient net weight, lineage effective-support must pick C.
  const snap = snapshotOf(
    [
      { agentId: 'llama-s', claimId: 'W', sourceIds: ['pool'] },
      { agentId: 'llama-m', claimId: 'W', sourceIds: ['pool'] },
      { agentId: 'llama-l', claimId: 'W', sourceIds: ['pool'] },
      { agentId: 'gemini', claimId: 'C', sourceIds: ['src-gemini'] },
      { agentId: 'claude', claimId: 'C', sourceIds: ['src-claude'] },
    ],
    { W: 0.7, C: 0.3 }, // coefficient fusion favors W — lineage must override
  );
  const decision = lineageWeightedWinner(snap, lineageRegistry(REGISTRY));
  assert.equal(decision.claimId, 'C');
  assert.ok(decision.effectiveSupport > 1.5, `C effective support ${decision.effectiveSupport} should clear ~2 independent`);
});

test('unknown lineage is fail-closed: unknown supporters are not counted as independent', () => {
  const support = [
    { agentId: 'x1', claimId: 'X', sourceIds: ['a'] },
    { agentId: 'x2', claimId: 'X', sourceIds: ['b'] },
    { agentId: 'x3', claimId: 'X', sourceIds: ['c'] },
  ];
  const independent: Record<string, ModelLineage> = {
    x1: { provider: 'meta', arch: 'llama', sizeClass: 'S', modelId: 'x1' },
    x2: { provider: 'google', arch: 'gemini', sizeClass: 'M', modelId: 'x2' },
    x3: { provider: 'anthropic', arch: 'claude', sizeClass: 'L', modelId: 'x3' },
  };
  const known = lineageWeightedWinner(snapshotOf(support, { X: 1 }), lineageRegistry(independent));
  const unknown = lineageWeightedWinner(snapshotOf(support, { X: 1 }), () => undefined);
  // With no registry match, the three supporters share the 'unknown' bucket and
  // are heavily discounted — effective support must be well below the ~3 they'd
  // get if each were treated as a distinct independent model.
  assert.ok(
    unknown.effectiveSupport < known.effectiveSupport,
    `unknown ${unknown.effectiveSupport} should be < known-independent ${known.effectiveSupport}`,
  );
  assert.ok(unknown.effectiveSupport < 2, `three unknowns ${unknown.effectiveSupport} must not reach a 2.0 quorum`);
});

test('no support yields a null decision', () => {
  const decision = lineageWeightedWinner(snapshotOf([], {}), lineageRegistry(REGISTRY));
  assert.equal(decision.claimId, null);
});
