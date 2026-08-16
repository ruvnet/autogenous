//! External outcome verification before a durable write (ADR-401 Dec 2):
//! external + independent affirmation, surviving adversarial refutation, fail-closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitDurableWrite,
  signOutcomeVerdict,
  outcomeHash,
  lineageRegistry,
  type OutcomeGatePolicy,
  type OutcomeVerdict,
  type ModelLineage,
} from '../src/index.js';
import { PeerIdentity } from '../src/transport.js';

const OUTCOME = { decision: 'ship', claim: 'opt-c' };
const HASH = outcomeHash(OUTCOME);

function verdict(v: PeerIdentity, stance: 'affirm' | 'refute', verified = true): OutcomeVerdict {
  return signOutcomeVerdict(v, { outcomeHash: HASH, verifierId: v.peerId, stance, verified, reason: 'checked' });
}
function trusted(...ids: PeerIdentity[]): Record<string, string> {
  return Object.fromEntries(ids.map((i) => [i.peerId, i.publicKeyDer.toString('hex')]));
}

test('admits on two external affirmations', () => {
  const [v1, v2] = [PeerIdentity.generate(), PeerIdentity.generate()];
  const policy: OutcomeGatePolicy = { trustedVerifiers: trusted(v1, v2), contributorIds: ['producer-a'], minAffirmations: 2 };
  const d = admitDurableWrite(HASH, [verdict(v1, 'affirm'), verdict(v2, 'affirm')], policy);
  assert.equal(d.admit, true);
  assert.equal(d.affirmations, 2);
});

test('a contributor cannot verify its own outcome (externality)', () => {
  const producer = PeerIdentity.generate();
  const external = PeerIdentity.generate();
  const policy: OutcomeGatePolicy = {
    trustedVerifiers: trusted(producer, external),
    contributorIds: [producer.peerId], // producer is a contributor ⇒ ignored
    minAffirmations: 2,
  };
  const d = admitDurableWrite(HASH, [verdict(producer, 'affirm'), verdict(external, 'affirm')], policy);
  assert.equal(d.affirmations, 1, 'the contributor self-attestation is dropped');
  assert.equal(d.admit, false);
  assert.equal(d.rejection, 'insufficient-affirmation');
});

test('a single valid external refutation blocks the write (adversarial)', () => {
  const [a1, a2, adversary] = [PeerIdentity.generate(), PeerIdentity.generate(), PeerIdentity.generate()];
  const policy: OutcomeGatePolicy = { trustedVerifiers: trusted(a1, a2, adversary), contributorIds: [], minAffirmations: 2 };
  const d = admitDurableWrite(HASH, [verdict(a1, 'affirm'), verdict(a2, 'affirm'), verdict(adversary, 'refute')], policy);
  assert.equal(d.admit, false);
  assert.equal(d.rejection, 'refuted');
});

test('no external verifier is fail-closed', () => {
  const policy: OutcomeGatePolicy = { trustedVerifiers: {}, contributorIds: [], minAffirmations: 1 };
  const d = admitDurableWrite(HASH, [], policy);
  assert.equal(d.admit, false);
  assert.equal(d.rejection, 'no-external-verifier');
});

test('untrusted signer, wrong-hash, and unverified verdicts are ignored', () => {
  const [trustedV, untrusted] = [PeerIdentity.generate(), PeerIdentity.generate()];
  const policy: OutcomeGatePolicy = { trustedVerifiers: trusted(trustedV), contributorIds: [], minAffirmations: 1 };
  const wrongHash = signOutcomeVerdict(trustedV, { outcomeHash: 'deadbeef', verifierId: trustedV.peerId, stance: 'affirm', verified: true, reason: 'x' });
  const unverified = signOutcomeVerdict(trustedV, { outcomeHash: HASH, verifierId: trustedV.peerId, stance: 'affirm', verified: false, reason: 'x' });
  const d = admitDurableWrite(HASH, [verdict(untrusted, 'affirm'), wrongHash, unverified], policy);
  assert.equal(d.admit, false);
  assert.equal(d.affirmations, 0);
});

test('graded independence: a same-lineage affirmer clique fails the effective-support quorum', () => {
  const [l1, l2, l3] = [PeerIdentity.generate(), PeerIdentity.generate(), PeerIdentity.generate()];
  const llama = (id: string, i: number): ModelLineage => ({ provider: 'meta', arch: 'llama', sizeClass: (['S', 'M', 'L'] as const)[i]!, modelId: id });
  const registry = { [l1.peerId]: llama(l1.peerId, 0), [l2.peerId]: llama(l2.peerId, 1), [l3.peerId]: llama(l3.peerId, 2) };
  const policy: OutcomeGatePolicy = {
    trustedVerifiers: trusted(l1, l2, l3), contributorIds: [], minAffirmations: 2,
    lineageOf: lineageRegistry(registry), minEffectiveSupport: 2.0,
  };
  const d = admitDurableWrite(HASH, [verdict(l1, 'affirm'), verdict(l2, 'affirm'), verdict(l3, 'affirm')], policy);
  assert.equal(d.admit, false);
  assert.equal(d.rejection, 'insufficient-independence');
  assert.ok(d.effectiveSupport! < 2.0);
});
