//! Tests for the three modules the mesh designed for itself (dogfood-1):
//! streamNonce replay binding, decorrelated evidence feeds, graded lineage
//! independence + counter-signing completion certs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerIdentity } from '../src/transport.js';
import { signFrame, verifyFrame, StreamNonceGate, type AgentFrame } from '../src/agent-frame.js';
import { partitionEvidence, type EvidenceRef } from '../src/evidence-feeds.js';
import {
  pairIndependence,
  effectiveSupport,
  buildCert,
  verifyCert,
  DEFAULT_INDEPENDENCE_WEIGHTS,
  type LineageSupport,
  type ModelLineage,
} from '../src/lineage-independence.js';

function frame(id: PeerIdentity, over: Partial<AgentFrame> = {}): AgentFrame {
  return signFrame(id, {
    requestId: 'r', agentId: 'a', step: 0, kind: 'claim', value: 'v',
    confidence: 0.8, uncertainty: 0.2, dependencies: [], capabilityUsed: 'x',
    evidenceHashes: [], cost: 0, ...over,
  } as Omit<AgentFrame, 'signature'>);
}

// ── item 4: in-frame replay binding ─────────────────────────────────────────

test('streamNonce binds a frame to its stream instance; cross-stream replay fails', () => {
  const producer = PeerIdentity.generate();
  const key = producer.publicKeyDer.toString('hex');
  const gateA = new StreamNonceGate('nonce-stream-a');
  const gateB = new StreamNonceGate('nonce-stream-b');

  const f = frame(producer, { streamNonce: 'nonce-stream-a' });
  assert.ok(verifyFrame(f, key), 'nonce is under the signature');
  assert.ok(gateA.accept(f), 'accepted on its own stream');
  assert.equal(gateA.accept(f), false, 'same (agentId, step) replay on the same stream rejected');
  assert.equal(gateB.accept(f), false, 'captured frame cannot cross to another stream');

  // Tampering the nonce breaks the signature — an attacker cannot re-target it.
  const retargeted = { ...f, streamNonce: 'nonce-stream-b' };
  assert.equal(verifyFrame(retargeted, key), false);
  // Frames without a nonce are rejected by a nonce-requiring gate.
  assert.equal(gateA.accept(frame(producer, { step: 1 })), false);
});

// ── item 1: decorrelated evidence feeds ─────────────────────────────────────

const POOL: EvidenceRef[] = [
  { id: 'e1', relevance: 0.9, stance: 1 }, { id: 'e2', relevance: 0.8, stance: -1 },
  { id: 'e3', relevance: 0.7, stance: 0 }, { id: 'e4', relevance: 0.6, stance: 1 },
  { id: 'e5', relevance: 0.5, stance: -1 }, { id: 'e6', relevance: 0.4, stance: 0 },
];

test('partitionEvidence: disjoint per-expert sets, deterministic, order-independent', () => {
  const feeds = partitionEvidence(POOL, ['b-expert', 'a-expert'], 2);
  const a = feeds.get('a-expert')!;
  const b = feeds.get('b-expert')!;
  assert.deepEqual([a.mode, b.mode], ['top', 'bottom'], 'modes cycle over LEXICOGRAPHIC expert order');
  const ids = [...a.refs, ...b.refs].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'sets are disjoint');
  // Input-order independence: shuffled pool + expert order yields identical feeds.
  const shuffled = partitionEvidence([...POOL].reverse(), ['a-expert', 'b-expert'], 2);
  assert.deepEqual(shuffled.get('a-expert'), a);
  assert.deepEqual(shuffled.get('b-expert'), b);
});

test('partitionEvidence: contrastive mode alternates stances; insufficient pool throws', () => {
  const feeds = partitionEvidence(POOL, ['x', 'y', 'z'], 2);
  const contrastive = feeds.get('z')!;
  assert.equal(contrastive.mode, 'contrastive');
  assert.throws(() => partitionEvidence(POOL, ['a', 'b', 'c', 'd'], 2), /insufficient/);
});

// ── items 2+3: lineage independence + counter-signing certs ─────────────────

const L = (provider: string, arch: string, sizeClass: ModelLineage['sizeClass'], modelId: string): ModelLineage =>
  ({ provider, arch, sizeClass, modelId });
const S = (agentId: string, lineage: ModelLineage, sourceIds: string[] = []): LineageSupport =>
  ({ agentId, principalId: 'p', lineage, sourceIds });

test('pairIndependence grades lineage overlap; effectiveSupport resists same-family stacking', () => {
  const llamaBig = S('a', L('meta', 'llama', 'XL', 'llama-3.2-90b'));
  const llamaMid = S('b', L('meta', 'llama', 'L', 'llama-3.1-70b'));
  const gemini = S('c', L('google', 'gemini', 'L', 'gemini-3.7-flash'));

  assert.equal(pairIndependence(llamaBig, llamaBig), 0, 'identical model = 0');
  const sameFamily = pairIndependence(llamaBig, llamaMid);
  const crossProvider = pairIndependence(llamaBig, gemini);
  assert.ok(sameFamily < 0.3, `same provider+arch heavily penalized: ${sameFamily}`);
  assert.ok(crossProvider > 0.8, `cross-provider mostly independent: ${crossProvider}`);

  // Three same-family supporters give barely more than one vote…
  const familyStack = effectiveSupport([llamaBig, llamaMid, S('d', L('meta', 'llama', 'M', 'llama-3-8b'))]);
  assert.ok(familyStack < 1.6, `family stack must not reach quorum 2: ${familyStack}`);
  // …while two genuinely diverse supporters clear it.
  const diverse = effectiveSupport([llamaBig, gemini]);
  assert.ok(diverse >= 1.8, `diverse pair ≈ 2 votes: ${diverse}`);
  // Shared evidence reduces independence (jaccard term).
  const sharedEv = pairIndependence(S('a', L('meta', 'llama', 'XL', 'm1'), ['ev1']), S('b', L('google', 'gemini', 'L', 'm2'), ['ev1']));
  assert.ok(sharedEv < crossProvider);
  // CONFIRMED axis (arXiv:2506.07962): two FRONTIER models correlate even
  // across providers — same accuracy band reduces independence.
  const fA = S('a', { ...L('meta', 'llama', 'XL', 'x1'), accuracyBand: 'frontier' as const });
  const fB = S('b', { ...L('google', 'gemini', 'L', 'x2'), accuracyBand: 'frontier' as const });
  const mixed = S('c', { ...L('google', 'gemini', 'L', 'x3'), accuracyBand: 'baseline' as const });
  assert.ok(pairIndependence(fA, fB) < pairIndependence(fA, mixed), 'same frontier band penalized');
});

test('CompletionCert: k-of-n counter-signing with clique resistance', () => {
  const executor = PeerIdentity.generate();
  const done = frame(executor, { kind: 'action', value: 'completed:deploy-check' });
  const v1 = { identity: PeerIdentity.generate(), lineage: L('anthropic', 'claude', 'XL', 'opus-5') };
  const v2 = { identity: PeerIdentity.generate(), lineage: L('google', 'gemini', 'L', 'gemini-3.7') };
  const policy = { k: 2, minPairIndependence: 0.5 };

  const cert = buildCert(done, [v1, v2]);
  assert.ok(verifyCert(cert, done, policy), 'independent 2-of-n cert verifies');

  // Same-lineage clique cannot self-quorum even with k valid signatures.
  const clique = buildCert(done, [
    { identity: PeerIdentity.generate(), lineage: L('meta', 'llama', 'L', 'l70') },
    { identity: PeerIdentity.generate(), lineage: L('meta', 'llama', 'XL', 'l90') },
  ]);
  assert.equal(verifyCert(clique, done, policy), false, 'clique blocked by minPairIndependence');

  // Tampered frame or forged signature fails.
  assert.equal(verifyCert(cert, { ...done, value: 'completed:something-else' }, policy), false);
  // MESH-REVIEW ATTACK 1: one valid (signer,sig) listed twice with FABRICATED
  // diverse lineages must not self-quorum — dedupe + lineage is attested.
  const dupAttack = {
    frameHash: cert.frameHash,
    signers: [cert.signers[0]!, cert.signers[0]!],
    sigs: [cert.sigs[0]!, cert.sigs[0]!],
    lineages: [v1.lineage, L('google', 'gemini', 'L', 'fabricated')],
  };
  assert.equal(verifyCert(dupAttack, done, policy), false, 'duplicated signer + fake lineage blocked');
  // Fabricating a DIFFERENT lineage for a real signature breaks the attestation.
  const fabLineage = { ...cert, lineages: [L('meta', 'llama', 'S', 'other'), cert.lineages[1]!] };
  assert.equal(verifyCert(fabLineage, done, policy), false, 'lineage is under the signature');
  // MESH-REVIEW ATTACK 2 (false rejection): an EXTRA correlated signer must not
  // break a cert that contains an independent k-subset.
  const v3 = { identity: PeerIdentity.generate(), lineage: L('google', 'gemini', 'L', 'gemini-3.7-b') };
  const withExtra = buildCert(done, [v1, v2, v3]); // v2+v3 correlated; v1+v2 independent
  assert.ok(verifyCert(withExtra, done, policy), 'k-subset acceptance: extra correlated signer tolerated');
  // Weights are tunable (unverified-claim caveat): zeroed weights make the clique pass.
  assert.ok(
    verifyCert(clique, done, { k: 2, minPairIndependence: 0.5, weights: { ...DEFAULT_INDEPENDENCE_WEIGHTS, sameProvider: 0, sameArch: 0, sameSize: 0 } }),
    'weights are configuration, not constants',
  );
});
