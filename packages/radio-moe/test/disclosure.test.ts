//! Sovereign-peer disclosure boundary (ADR-401 cap 6): disclose signed findings +
//! confidence + permitted evidence refs only; raw data and above-ceiling evidence
//! never cross; signature is verifiable; over-disclosure is catchable.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discloseFinding,
  verifyDisclosure,
  assertWithinCeiling,
  evidenceDigest,
  type InternalFinding,
  type Disclosure,
} from '../src/index.js';
import { PeerIdentity } from '../src/transport.js';

const NOW = 1_800_000_000_000;

const finding: InternalFinding = {
  claim: 'fraud-ring-detected',
  confidence: 0.82,
  raw: { customerId: 'SECRET-12345', pan: '4111-1111-1111-1111' }, // must never leak
  evidence: [
    { id: 'ev-pub', privacyClass: 'public', payload: { pattern: 'velocity-spike' } },
    { id: 'ev-int', privacyClass: 'internal', payload: { model: 'v3' } },
    { id: 'ev-restricted', privacyClass: 'restricted', payload: { account: 'acct-9' } },
    { id: 'ev-sensitive', privacyClass: 'sensitive', payload: { ssn: '000-00-0000' } },
  ],
};

test('discloses claim + confidence + only at/below-ceiling evidence refs', () => {
  const peer = PeerIdentity.generate();
  const d = discloseFinding(peer, finding, { maxPrivacyClass: 'internal' }, NOW);
  assert.equal(d.claim, 'fraud-ring-detected');
  assert.equal(d.confidence, 0.82); // confidence disclosed — ahead of CTA
  const ids = d.evidenceRefs.map((r) => r.id).sort();
  assert.deepEqual(ids, ['ev-int', 'ev-pub'], 'restricted + sensitive evidence dropped at internal ceiling');
  // refs carry digests, not payloads
  assert.equal(d.evidenceRefs.find((r) => r.id === 'ev-pub')!.digest, evidenceDigest(finding.evidence[0]!));
});

test('raw data and evidence payloads NEVER appear in the disclosed shape', () => {
  const peer = PeerIdentity.generate();
  const d = discloseFinding(peer, finding, { maxPrivacyClass: 'sensitive' }, NOW);
  const json = JSON.stringify(d);
  assert.ok(!json.includes('SECRET-12345'), 'raw.customerId leaked');
  assert.ok(!json.includes('4111-1111-1111-1111'), 'raw.pan leaked');
  assert.ok(!json.includes('000-00-0000'), 'sensitive payload leaked');
  assert.ok(!json.includes('velocity-spike'), 'even public payload is not disclosed — only its digest');
  assert.ok(!('raw' in (d as unknown as Record<string, unknown>)), 'no raw field on the disclosure');
});

test('signature verifies and tampering is rejected', () => {
  const peer = PeerIdentity.generate();
  const key = peer.publicKeyDer.toString('hex');
  const d = discloseFinding(peer, finding, { maxPrivacyClass: 'restricted' }, NOW);
  assert.equal(verifyDisclosure(d, key), true);
  const tampered: Disclosure = { ...d, confidence: 0.99 };
  assert.equal(verifyDisclosure(tampered, key), false);
  // a different peer's key does not verify
  assert.equal(verifyDisclosure(d, PeerIdentity.generate().publicKeyDer.toString('hex')), false);
});

test('assertWithinCeiling catches a maliciously over-disclosed ref', () => {
  const peer = PeerIdentity.generate();
  const d = discloseFinding(peer, finding, { maxPrivacyClass: 'public' }, NOW);
  assert.equal(assertWithinCeiling(d), true);
  const overreach: Disclosure = { ...d, evidenceRefs: [{ id: 'x', privacyClass: 'sensitive', digest: 'deadbeef' }] };
  assert.equal(assertWithinCeiling(overreach), false);
});

test('confidence is clamped into [0,1]', () => {
  const peer = PeerIdentity.generate();
  assert.equal(discloseFinding(peer, { ...finding, confidence: 1.7 }, { maxPrivacyClass: 'public' }, NOW).confidence, 1);
  assert.equal(discloseFinding(peer, { ...finding, confidence: -0.3 }, { maxPrivacyClass: 'public' }, NOW).confidence, 0);
});
