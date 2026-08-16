//! Signed reputation ledger (ADR-401 cap 9): reputation accrues ONLY from
//! externally-verified contribution; self-reported/unverified records are ignored.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signCapabilityClaim,
  verifyCapabilityClaim,
  mintPerformanceRecord,
  verifyPerformanceRecord,
  reputation,
  selectionWeight,
  outcomeHash,
  signOutcomeVerdict,
  type OutcomeGatePolicy,
  type PerformanceRecord,
} from '../src/index.js';
import { PeerIdentity } from '../src/transport.js';

const NOW = 1_800_000_000_000;
const OUTCOME = { task: 'route-fix', result: 'shipped' };
const HASH = outcomeHash(OUTCOME);

// The contributor whose reputation we track, plus two external verifiers.
const worker = PeerIdentity.generate();
const [v1, v2] = [PeerIdentity.generate(), PeerIdentity.generate()];

function policy(): OutcomeGatePolicy {
  return {
    trustedVerifiers: Object.fromEntries([v1, v2].map((v) => [v.peerId, v.publicKeyDer.toString('hex')])),
    contributorIds: [worker.peerId],
    minAffirmations: 2,
  };
}
function verdicts(stance: 'affirm' | 'refute' = 'affirm') {
  return [v1, v2].map((v) => signOutcomeVerdict(v, { outcomeHash: HASH, verifierId: v.peerId, stance, verified: true, reason: 'ok' }));
}

test('capability claims sign and verify', () => {
  const claim = signCapabilityClaim(worker, { agentId: worker.peerId, capability: 'routing', advertisedQuality: 0.9, issuedAt: NOW });
  assert.equal(verifyCapabilityClaim(claim, worker.publicKeyDer.toString('hex')), true);
  assert.equal(verifyCapabilityClaim({ ...claim, advertisedQuality: 0.1 }, worker.publicKeyDer.toString('hex')), false);
});

test('a record mints only for an externally-verified outcome; reputation accrues from it', () => {
  const rec = mintPerformanceRecord(worker, HASH, 0.8, verdicts('affirm'), policy(), NOW);
  assert.ok(rec, 'record should mint when the outcome is externally verified');
  assert.equal(verifyPerformanceRecord(rec!, worker.publicKeyDer.toString('hex'), policy()), true);
  const rep = reputation(worker.peerId, [rec!], worker.publicKeyDer.toString('hex'), policy());
  assert.equal(rep.verifiedContributions, 1);
  assert.equal(rep.meanQuality, 0.8);
});

test('no reputation from an UNVERIFIED outcome (only one affirmation)', () => {
  const oneVerdict = [verdicts('affirm')[0]!];
  const rec = mintPerformanceRecord(worker, HASH, 0.9, oneVerdict, policy(), NOW);
  assert.equal(rec, null, 'insufficient external affirmation ⇒ no record minted');
});

test('a refuted outcome mints nothing', () => {
  const rec = mintPerformanceRecord(worker, HASH, 0.9, [...verdicts('affirm'), signOutcomeVerdict(v1, { outcomeHash: HASH, verifierId: v1.peerId, stance: 'refute', verified: true, reason: 'bad' })], policy(), NOW);
  // v1 now both affirms and refutes; de-dup keeps one vote — the refute blocks.
  assert.equal(rec, null);
});

test('a forged/self-reported record (verdicts stripped) is ignored by reputation', () => {
  const rec = mintPerformanceRecord(worker, HASH, 0.9, verdicts('affirm'), policy(), NOW)!;
  const forged: PerformanceRecord = { ...rec, verdicts: [] }; // strip the proof
  // Signature no longer matches (verdicts changed) AND it wouldn't verify anyway.
  assert.equal(verifyPerformanceRecord(forged, worker.publicKeyDer.toString('hex'), policy()), false);
  const rep = reputation(worker.peerId, [forged], worker.publicKeyDer.toString('hex'), policy());
  assert.equal(rep.verifiedContributions, 0);
});

test('a non-contributor cannot mint a record for the outcome', () => {
  const outsider = PeerIdentity.generate();
  const rec = mintPerformanceRecord(outsider, HASH, 0.9, verdicts('affirm'), policy(), NOW);
  assert.equal(rec, null, 'outsider is not in contributorIds ⇒ no record');
});

test('selectionWeight computes q*t*r/(c*l) — UNVALIDATED hypothesis, just arithmetic here', () => {
  const w = selectionWeight({ quality: 0.8, trust: 0.5, relevance: 1, cost: 0.4, latency: 0.5 });
  assert.ok(Math.abs(w - (0.8 * 0.5 * 1) / (0.4 * 0.5)) < 1e-9);
  // divide-by-zero guarded
  assert.ok(Number.isFinite(selectionWeight({ quality: 1, trust: 1, relevance: 1, cost: 0, latency: 0 })));
});
