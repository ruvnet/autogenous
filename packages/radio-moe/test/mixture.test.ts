import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signFrame, type AgentFrame } from '../src/agent-frame.js';
import {
  MixtureState,
  signContributionInput,
  type ContributionInput,
  type UnsignedContributionInput,
} from '../src/mixture.js';
import { PeerIdentity } from '../src/transport.js';

const requestId = 'mixture-request';

function fixture() {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const signers = {
    a: a.publicKeyDer.toString('hex'),
    b: b.publicKeyDer.toString('hex'),
  };
  const frame = (
    identity: PeerIdentity,
    agentId: 'a' | 'b',
    step: number,
    value: unknown,
    kind: 'claim' | 'evidence' = 'claim',
  ): AgentFrame => signFrame(identity, {
    requestId,
    agentId,
    step,
    kind,
    value,
    confidence: 0.8,
    uncertainty: 0.2,
    dependencies: [],
    capabilityUsed: 'reasoning',
    evidenceHashes: [`evidence-${agentId}-${step}`],
    cost: 0.01,
  });
  return { a, b, signers, frame };
}

function input(
  identity: PeerIdentity,
  signedFrame: AgentFrame,
  overrides: Partial<UnsignedContributionInput> = {},
): ContributionInput {
  return signContributionInput(identity, signedFrame, {
    claimId: 'claim-42',
    relation: 'support',
    sourceIds: ['source-default'],
    quality: 0.8,
    relevance: 0.9,
    evidence: 0.7,
    cost: 0.1,
    latency: 0.2,
    uncertainty: 0.2,
    ...overrides,
  });
}

test('verified claim and evidence frames produce weighted provenance updates', () => {
  const { a, b, signers, frame } = fixture();
  const mixture = new MixtureState({ requestId, trustedSigners: signers, topK: 4 });
  const claim = frame(a, 'a', 0, { text: 'answer is 42' });
  mixture.consume(claim, input(a, claim, { sourceIds: ['source-a'] }));
  const evidence = frame(b, 'b', 0, { citation: 'private result' }, 'evidence');
  const update = mixture.consume(
    evidence,
    input(b, evidence, { evidence: 1, sourceIds: ['source-b'] }),
  );

  assert.equal(update.status, 'accepted');
  assert.equal(update.snapshot.contributions.length, 2);
  assert.equal(update.snapshot.audit.length, 2);
  assert.equal(update.snapshot.claims[0]!.claimId, 'claim-42');
  assert.deepEqual(update.snapshot.claims[0]!.sourceIds, ['source-a', 'source-b']);
  assert.equal(update.snapshot.claims[0]!.supportWeight, 1);
  assert.equal(update.snapshot.contributions.reduce((sum, item) => sum + item.weight, 0), 1);
  assert.ok(update.snapshot.contributions[0]!.score > update.snapshot.contributions[1]!.score);
});

test('replicated state is deterministic across arrival order and drains step gaps', () => {
  const { a, b, signers, frame } = fixture();
  const a0 = frame(a, 'a', 0, 'a0');
  const a1 = frame(a, 'a', 1, 'a1');
  const a1Replica = frame(a, 'a', 1, 'a1');
  const b0 = frame(b, 'b', 0, 'b0');
  const left = new MixtureState({ requestId, trustedSigners: signers });
  const right = new MixtureState({ requestId, trustedSigners: signers });

  assert.equal(left.consume(a1, input(a, a1)).status, 'buffered');
  a1.value = 'caller mutation after verification';
  left.consume(b0, input(b, b0));
  const drained = left.consume(a0, input(a, a0));
  right.consume(a0, input(a, a0));
  right.consume(a1Replica, input(a, a1Replica));
  right.consume(b0, input(b, b0));

  assert.equal(drained.status, 'accepted');
  if (drained.status === 'accepted') assert.equal(drained.acceptedFrameHashes.length, 2);
  assert.equal(left.snapshot().bufferedFrames, 0);
  assert.equal(left.snapshot().stateHash, right.snapshot().stateHash);
  assert.deepEqual(left.snapshot(), right.snapshot());
});

test('support and contradiction remain explicit instead of becoming false consensus', () => {
  const { a, b, signers, frame } = fixture();
  const mixture = new MixtureState({ requestId, trustedSigners: signers });
  const healthy = frame(a, 'a', 0, 'service is healthy');
  mixture.consume(healthy, input(a, healthy, { sourceIds: ['telemetry-a'] }));
  const unhealthy = frame(b, 'b', 0, 'service is unhealthy');
  const update = mixture.consume(
    unhealthy,
    input(b, unhealthy, { relation: 'contradict', sourceIds: ['telemetry-b'], quality: 1 }),
  );

  assert.equal(update.snapshot.claims[0]!.contradictory, true);
  assert.ok(update.snapshot.claims[0]!.supportWeight > 0);
  assert.ok(update.snapshot.claims[0]!.contradictionWeight > 0);
  assert.equal(update.snapshot.contradictions.length, 1);
  assert.equal(update.snapshot.contradictions[0]!.supportingFrames.length, 1);
  assert.equal(update.snapshot.contradictions[0]!.contradictingFrames.length, 1);
});

test('invalid, untrusted, replayed, and non-claim inputs cannot affect the mixture', () => {
  const { a, signers, frame } = fixture();
  const outsider = PeerIdentity.generate();
  const mixture = new MixtureState({ requestId, trustedSigners: signers });
  const before = mixture.snapshot().stateHash;

  const untrusted = frame(outsider, 'a', 0, 'forged');
  assert.equal(mixture.consume(untrusted, input(outsider, untrusted)).status, 'rejected');
  assert.equal(mixture.snapshot().stateHash, before);

  const honest = frame(a, 'a', 0, 'valid');
  assert.equal(mixture.consume(honest, input(a, honest, { quality: Number.NaN })).status, 'rejected');
  assert.equal(mixture.consume({ ...honest, value: 'tampered' }, input(a, honest)).status, 'rejected');
  assert.equal(mixture.consume({ ...honest, kind: 'action' }, input(a, honest)).status, 'rejected');
  const honestInput = input(a, honest);
  assert.equal(mixture.consume(honest, honestInput).status, 'accepted');
  assert.equal(mixture.consume(honest, honestInput).status, 'duplicate');
  assert.equal(mixture.snapshot().contributions.length, 1);
});

test('bounded dimensions, coefficients, top-k, and gap buffers enforce limits', () => {
  const { a, b, signers, frame } = fixture();
  assert.throws(
    () => new MixtureState({ requestId, trustedSigners: signers, coefficients: { quality: 101 } }),
    /coefficient quality/,
  );
  const mixture = new MixtureState({
    requestId,
    trustedSigners: signers,
    topK: 1,
    maxAcceptedFrames: 2,
    maxBufferedFramesPerAgent: 1,
  });
  const low = frame(a, 'a', 0, 'low');
  const high = frame(b, 'b', 0, 'high');
  assert.equal(mixture.consume(low, input(a, low, { quality: 0, relevance: 0, evidence: 0, cost: 1, latency: 1, uncertainty: 1 })).status, 'accepted');
  assert.equal(mixture.consume(high, input(b, high, { quality: 1, relevance: 1, evidence: 1, cost: 0, latency: 0, uncertainty: 0 })).status, 'accepted');
  assert.equal(mixture.snapshot().contributions.length, 1, 'only TopK contributes to visible mixture');
  assert.equal(mixture.snapshot().audit.length, 2, 'all accepted provenance remains auditable');
  assert.equal(mixture.snapshot().contributions[0]!.value, 'high');

  const buffered = new MixtureState({ requestId, trustedSigners: signers, maxBufferedFramesPerAgent: 1 });
  const gap2 = frame(a, 'a', 2, 'gap-2');
  const gap3 = frame(a, 'a', 3, 'gap-3');
  assert.equal(buffered.consume(gap2, input(a, gap2)).status, 'buffered');
  const overflow = buffered.consume(gap3, input(a, gap3));
  assert.equal(overflow.status, 'rejected');
  if (overflow.status === 'rejected') assert.match(overflow.reason, /buffer/);
  const badBoundary = frame(b, 'b', 0, 'bad-boundary');
  assert.equal(buffered.consume(badBoundary, input(b, badBoundary, { latency: 1.000_001 })).status, 'rejected');
});

test('signed contribution binding prevents semantic and score rebinding', () => {
  const { a, signers, frame } = fixture();
  const signed = frame(a, 'a', 0, 'same signed claim');
  const bound = input(a, signed, { claimId: 'claim-good', relation: 'support', quality: 0.8 });
  const mixture = new MixtureState({ requestId, trustedSigners: signers });
  for (const tampered of [
    { ...bound, claimId: 'claim-evil' },
    { ...bound, relation: 'contradict' as const },
    { ...bound, sourceIds: ['forged-source'] },
    { ...bound, quality: 1 },
  ]) {
    const update = mixture.consume(signed, tampered);
    assert.equal(update.status, 'rejected');
    if (update.status === 'rejected') assert.match(update.reason, /binding signature/);
  }
  assert.equal(mixture.snapshot().audit.length, 0);

  // A signer cannot equivocate by issuing two valid bindings for one frame.
  const alternate = input(a, signed, { claimId: 'claim-evil', relation: 'contradict' });
  const left = new MixtureState({ requestId, trustedSigners: signers });
  const right = new MixtureState({ requestId, trustedSigners: signers });
  left.consume(signed, bound);
  left.consume(signed, alternate);
  right.consume(signed, alternate);
  right.consume(signed, bound);
  assert.deepEqual(left.snapshot(), right.snapshot());
  assert.deepEqual(left.snapshot().equivocatingAgents, ['a']);
});

test('valid same-step equivocation quarantines the signer and replicas converge', () => {
  const { a, signers, frame } = fixture();
  const x = frame(a, 'a', 0, 'x');
  const y = frame(a, 'a', 0, 'y');
  const left = new MixtureState({ requestId, trustedSigners: signers });
  const right = new MixtureState({ requestId, trustedSigners: signers });

  assert.equal(left.consume(x, input(a, x)).status, 'accepted');
  assert.equal(left.consume(y, input(a, y)).status, 'rejected');
  assert.equal(right.consume(y, input(a, y)).status, 'accepted');
  assert.equal(right.consume(x, input(a, x)).status, 'rejected');

  assert.deepEqual(left.snapshot(), right.snapshot());
  assert.deepEqual(left.snapshot().equivocatingAgents, ['a']);
  assert.equal(left.snapshot().audit.length, 0);
  const later = frame(a, 'a', 1, 'ignored after quarantine');
  assert.equal(left.consume(later, input(a, later)).status, 'rejected');
});

test('strict bounded JSON and provenance reject ambiguous or oversized input before crypto', () => {
  const { a, signers, frame } = fixture();
  const mixture = new MixtureState({ requestId, trustedSigners: signers });
  const ambiguous = frame(a, 'a', 0, { x: undefined });
  const ambiguousInput = input(a, ambiguous);
  const forgedAmbiguous = { ...ambiguous, signature: '0'.repeat(128) };
  const forgedBinding = input(a, forgedAmbiguous);
  const ambiguousUpdate = mixture.consume(forgedAmbiguous, forgedBinding);
  assert.equal(ambiguousUpdate.status, 'rejected');
  if (ambiguousUpdate.status === 'rejected') assert.match(ambiguousUpdate.reason, /strict bounded JSON/);

  const oversized = frame(a, 'a', 0, 'x'.repeat(64 * 1024 + 1));
  const oversizedUpdate = mixture.consume(oversized, input(a, oversized));
  assert.equal(oversizedUpdate.status, 'rejected');
  if (oversizedUpdate.status === 'rejected') assert.match(oversizedUpdate.reason, /string exceeds/);

  const validOversizedRefs = signFrame(a, {
    requestId,
    agentId: 'a',
    step: 0,
    kind: 'claim',
    value: 'bounded',
    confidence: 0.8,
    uncertainty: 0.2,
    dependencies: Array.from({ length: 257 }, (_, index) => `d-${index}`),
    capabilityUsed: 'reasoning',
    evidenceHashes: ['evidence-a-0'],
    cost: 0.01,
  });
  const refsUpdate = mixture.consume(validOversizedRefs, input(a, validOversizedRefs));
  assert.equal(refsUpdate.status, 'rejected');
  if (refsUpdate.status === 'rejected') assert.match(refsUpdate.reason, /provenance arrays/);
  assert.equal(ambiguousInput.bindingSignature.length, 128);
});

test('largest-remainder softmax is nonnegative and quantized units sum to one', () => {
  const identities = Array.from({ length: 20 }, () => PeerIdentity.generate());
  const trustedSigners = Object.fromEntries(
    identities.map((identity, index) => [`agent-${index}`, identity.publicKeyDer.toString('hex')]),
  );
  const mixture = new MixtureState({ requestId, trustedSigners, topK: 20, maxAcceptedFrames: 20, precision: 1 });
  identities.forEach((identity, index) => {
    const signed = signFrame(identity, {
      requestId,
      agentId: `agent-${index}`,
      step: 0,
      kind: 'claim',
      value: index,
      confidence: 0.8,
      uncertainty: 0.2,
      dependencies: [],
      capabilityUsed: 'reasoning',
      evidenceHashes: [`evidence-${index}`],
      cost: 0,
    });
    mixture.consume(signed, input(identity, signed, { sourceIds: [`source-${index}`] }));
  });
  const weights = mixture.snapshot().contributions.map((item) => item.weight);
  assert.ok(weights.every((weight) => weight >= 0));
  assert.equal(weights.reduce((units, weight) => units + Math.round(weight * 10), 0), 10);
});

test('shared source or evidence cannot multiply claim confidence', () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const c = PeerIdentity.generate();
  const trustedSigners = Object.fromEntries([a, b, c].map((identity, index) => [
    `agent-${index}`,
    identity.publicKeyDer.toString('hex'),
  ]));
  const mixture = new MixtureState({ requestId, trustedSigners, topK: 3 });
  const identities = [a, b, c];
  identities.forEach((identity, index) => {
    const signed = signFrame(identity, {
      requestId,
      agentId: `agent-${index}`,
      step: 0,
      kind: 'claim',
      value: index < 2 ? 'support' : 'contradict',
      confidence: 0.8,
      uncertainty: 0.2,
      dependencies: [],
      capabilityUsed: 'reasoning',
      evidenceHashes: [`evidence-${index}`],
      cost: 0,
    });
    mixture.consume(signed, input(identity, signed, {
      relation: index < 2 ? 'support' : 'contradict',
      sourceIds: index < 2 ? ['shared-source'] : ['independent-source'],
      quality: 1 - index * 0.1,
    }));
  });
  const snapshot = mixture.snapshot();
  assert.equal(snapshot.audit.length, 3);
  assert.equal(snapshot.contributions.length, 2);
  assert.equal(snapshot.audit.filter((item) => item.weight === 0).length, 1);
  assert.ok(snapshot.claims[0]!.supportWeight < 1);
  assert.ok(snapshot.claims[0]!.contradictionWeight > 0);
});
