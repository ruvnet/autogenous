//! Graded-independence action gate (ADR-401 cap 3): a same-lineage clique that
//! passes the BINARY quorum must still fail the lineage-discounted quorum, while
//! a genuinely independent set clears both. Opt-in and strictly tightening.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActionGate,
  signActionSupport,
  type ActionGateOptions,
  type ActionSupport,
  type GovernedAction,
  type ModelLineage,
  type UnsignedActionSupport,
} from '../src/index.js';
import { PeerIdentity } from '../src/transport.js';

const NOW = 1_800_000_000_000;
const action: GovernedAction = {
  capability: 'repo.write', tool: 'apply_patch', target: 'src/service.ts',
  arguments: { patch: { after: 2, before: 1 } }, jurisdiction: 'project:ruflo',
};

function trusted(...ids: PeerIdentity[]): Map<string, string> {
  return new Map(ids.map((id) => [id.peerId, id.publicKeyDer.toString('hex')]));
}
function support(id: PeerIdentity, overrides: Partial<UnsignedActionSupport> = {}): ActionSupport {
  return signActionSupport(id, {
    agentId: id.peerId, principalId: `principal-${id.peerId}`, modelId: `model-${id.peerId}`,
    sourceIds: [`source-${id.peerId}`], evidenceHashes: [`evidence-${id.peerId}`],
    calibration: 0.8, risk: 0.2, action, issuedAt: NOW - 1, expiresAt: NOW + 10_000,
    ...overrides,
  });
}
function gate(ids: PeerIdentity[], overrides: Partial<ActionGateOptions> = {}): ActionGate {
  return new ActionGate({
    minimumQuorum: 2, riskThreshold: 0.5, admissible: () => true, trustedSigners: trusted(...ids), ...overrides,
  });
}
const llama = (i: number): ModelLineage => ({ provider: 'meta', arch: 'llama', sizeClass: (['S', 'M', 'L'] as const)[i]!, modelId: `llama-${i}` });

test('a same-provider/arch clique passes the binary quorum but FAILS the graded quorum', async () => {
  const [a, b, c] = [PeerIdentity.generate(), PeerIdentity.generate(), PeerIdentity.generate()];
  // Distinct agents/models/sources ⇒ binary independence counts all three.
  const supports = [a, b, c].map((id, i) => support(id, { lineage: llama(i) }));

  const binary = await gate([a, b, c]).evaluate(action, supports, NOW);
  assert.equal(binary.execute, true, 'binary quorum should pass three distinct signers');

  const graded = await gate([a, b, c], {
    gradedIndependence: { minimumEffectiveSupport: 2.0 },
  }).evaluate(action, supports, NOW);
  assert.equal(graded.execute, false);
  assert.equal(graded.rejection, 'insufficient-effective-support');
  assert.ok(graded.effectiveSupport! < 2.0, `clique effective support ${graded.effectiveSupport} must be < 2.0`);
});

test('a genuinely independent set clears the graded quorum', async () => {
  const [a, b] = [PeerIdentity.generate(), PeerIdentity.generate()];
  const supports = [
    support(a, { lineage: { provider: 'meta', arch: 'llama', sizeClass: 'L', modelId: 'llama-l' } }),
    support(b, { lineage: { provider: 'google', arch: 'gemini', sizeClass: 'XL', modelId: 'gemini-xl' } }),
  ];
  const decision = await gate([a, b], { gradedIndependence: { minimumEffectiveSupport: 2.0 } }).evaluate(action, supports, NOW);
  assert.equal(decision.execute, true, `independent pair should clear graded quorum (effective ${decision.effectiveSupport})`);
  assert.ok(decision.effectiveSupport! >= 2.0);
});

test('absent lineage is fail-closed: unproven provenance is discounted, not counted', async () => {
  const [a, b, c] = [PeerIdentity.generate(), PeerIdentity.generate(), PeerIdentity.generate()];
  // No lineage on any support ⇒ shared 'unknown' bucket ⇒ heavily discounted.
  const supports = [a, b, c].map((id) => support(id));
  const decision = await gate([a, b, c], { gradedIndependence: { minimumEffectiveSupport: 2.0 } }).evaluate(action, supports, NOW);
  assert.equal(decision.execute, false);
  assert.equal(decision.rejection, 'insufficient-effective-support');
  assert.ok(decision.effectiveSupport! < 2.0);
});

test('graded mode is opt-in: without it, behavior is unchanged (binary clique passes)', async () => {
  const [a, b, c] = [PeerIdentity.generate(), PeerIdentity.generate(), PeerIdentity.generate()];
  const supports = [a, b, c].map((id, i) => support(id, { lineage: llama(i) }));
  const decision = await gate([a, b, c]).evaluate(action, supports, NOW);
  assert.equal(decision.execute, true);
  assert.equal(decision.effectiveSupport, undefined, 'no effectiveSupport reported when graded mode is off');
});

test('rejects an out-of-range minimumEffectiveSupport at construction', () => {
  const a = PeerIdentity.generate();
  assert.throws(() => gate([a], { gradedIndependence: { minimumEffectiveSupport: 0.5 } }), /minimumEffectiveSupport/);
  assert.throws(() => gate([a], { gradedIndependence: { minimumEffectiveSupport: Number.NaN } }), /minimumEffectiveSupport/);
});
