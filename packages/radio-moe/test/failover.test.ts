import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeterministicShadow,
  OUTPUT_PROTOCOL_VERSION,
  createTakeoverGrant,
  signOutputEnvelope,
  type MixtureCheckpoint,
  type OutputEnvelope,
  type OutputRegime,
  type UnsignedTakeoverGrant,
} from '../src/failover.js';
import { PeerIdentity } from '../src/transport.js';

const NOW = 1_800_000_000_000;

function checkpoint(shadow: DeterministicShadow, payload: unknown): MixtureCheckpoint {
  const cursor = shadow.cursor;
  const frameId = `frame-${cursor.nextSequence}`;
  const previousFrames = cursor.checkpoint?.acceptedFrameIds ?? [];
  const previousSteps = cursor.checkpoint?.agentSteps ?? {};
  return {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    requestId: shadow.requestId,
    routeEpoch: cursor.routeEpoch,
    window: cursor.nextSequence,
    acceptedFrameIds: [...previousFrames, frameId],
    agentSteps: { ...previousSteps, agent: cursor.nextSequence },
    mixtureState: {
      priorStateHash: cursor.lastStateHash,
      visible: payload,
      weightsMicros: { agent: 1_000_000 },
    },
  };
}

function nextEnvelope(identity: PeerIdentity, shadow: DeterministicShadow, payload: unknown, eventId?: string): OutputEnvelope {
  const cursor = shadow.cursor;
  return signOutputEnvelope(identity, {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    routeEpoch: cursor.routeEpoch,
    eventId: eventId ?? `event-${cursor.mixerEpoch}-${cursor.nextSequence}`,
    kind: 'claim',
    regime: cursor.regime,
    requestId: shadow.requestId,
    mixerEpoch: cursor.mixerEpoch,
    sequence: cursor.nextSequence,
    previousHash: cursor.lastEnvelopeHash,
    previousStateHash: cursor.lastStateHash,
    payload,
    contributionIds: [`frame-${cursor.nextSequence}`],
    checkpoint: checkpoint(shadow, payload),
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
  });
}

function takeoverGrant(
  authority: PeerIdentity,
  primary: PeerIdentity,
  replacement: PeerIdentity,
  shadow: DeterministicShadow,
  overrides: Partial<UnsignedTakeoverGrant> = {},
) {
  const cursor = shadow.cursor;
  return createTakeoverGrant(authority, {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    routeEpoch: cursor.routeEpoch,
    regime: cursor.regime,
    grantId: `grant-${cursor.mixerEpoch + 1}`,
    requestId: shadow.requestId,
    fromMixerId: primary.peerId,
    toMixerId: replacement.peerId,
    toMixerPublicKeyDer: replacement.publicKeyDer.toString('hex'),
    mixerEpoch: cursor.mixerEpoch + 1,
    lastSequence: cursor.nextSequence - 1,
    lastEnvelopeHash: cursor.lastEnvelopeHash,
    lastStateHash: cursor.lastStateHash,
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
    ...overrides,
  });
}

test('shadow commits signed monotonic output and retains a replayable checkpoint', () => {
  const mixer = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', mixer.peerId, mixer.publicKeyDer.toString('hex'), { routeEpoch: 7 });
  shadow.replicate(nextEnvelope(mixer, shadow, { delta: 'one' }), NOW);
  shadow.replicate(nextEnvelope(mixer, shadow, { delta: 'two' }), NOW);
  assert.equal(shadow.cursor.nextSequence, 2);
  assert.equal(shadow.cursor.routeEpoch, 7);
  assert.deepEqual(shadow.cursor.checkpoint?.acceptedFrameIds, ['frame-0', 'frame-1']);
  assert.deepEqual(shadow.cursor.checkpoint?.mixtureState, {
    priorStateHash: shadow.cursor.checkpoint && (shadow.cursor.checkpoint.mixtureState as { priorStateHash: string }).priorStateHash,
    visible: { delta: 'two' },
    weightsMicros: { agent: 1_000_000 },
  });
});

test('payload and checkpoint tampering are rejected before replicated state changes', () => {
  const mixer = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', mixer.peerId, mixer.publicKeyDer.toString('hex'));
  const signed = nextEnvelope(mixer, shadow, { delta: 'safe' });
  assert.throws(() => shadow.replicate({ ...signed, payload: { delta: 'evil' } }, NOW), /signature is invalid/);
  assert.throws(
    () => shadow.replicate({ ...signed, checkpoint: { ...signed.checkpoint, mixtureState: { forged: true } } }, NOW),
    /signature is invalid/,
  );
  assert.equal(shadow.cursor.nextSequence, 0);
});

test('replay, reused event ids, sequence gaps, and forks are rejected', () => {
  const mixer = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', mixer.peerId, mixer.publicKeyDer.toString('hex'));
  const first = nextEnvelope(mixer, shadow, 'first');
  shadow.replicate(first, NOW);
  assert.throws(() => shadow.replicate(first, NOW), /already committed/);

  const reusedEvent = nextEnvelope(mixer, shadow, 'reused-id', first.eventId);
  assert.throws(() => shadow.replicate(reusedEvent, NOW), /event was already committed/);

  const forkA = nextEnvelope(mixer, shadow, 'fork-a', 'fork-a');
  const forkB = nextEnvelope(mixer, shadow, 'fork-b', 'fork-b');
  shadow.replicate(forkA, NOW);
  assert.throws(() => shadow.replicate(forkB, NOW), /already committed/);

  const cursor = shadow.cursor;
  const gap = signOutputEnvelope(mixer, {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    routeEpoch: cursor.routeEpoch,
    eventId: 'event-gap',
    kind: 'claim',
    regime: cursor.regime,
    requestId: shadow.requestId,
    mixerEpoch: cursor.mixerEpoch,
    sequence: cursor.nextSequence + 1,
    previousHash: cursor.lastEnvelopeHash,
    previousStateHash: cursor.lastStateHash,
    payload: 'third',
    contributionIds: ['frame-1'],
    checkpoint: checkpoint(shadow, 'third'),
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
  });
  assert.throws(() => shadow.replicate(gap, NOW), /sequence has a gap/);

  const fork = nextEnvelope(mixer, shadow, 'tampered-chain');
  const broken = { ...fork, previousHash: '0'.repeat(64) };
  assert.throws(() => shadow.replicate(broken, NOW), /signature is invalid/);
});

test('signed fenced takeover continues exact checkpoint chain and excludes old mixer', () => {
  const authority = PeerIdentity.generate();
  const primary = PeerIdentity.generate();
  const replacement = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', primary.peerId, primary.publicKeyDer.toString('hex'), { routeEpoch: 3 });
  shadow.replicate(nextEnvelope(primary, shadow, 'primary-output'), NOW);
  const grant = takeoverGrant(authority, primary, replacement, shadow);
  shadow.takeover(grant, authority.publicKeyDer.toString('hex'), NOW);
  shadow.replicate(nextEnvelope(replacement, shadow, 'replacement-output'), NOW);
  assert.equal(shadow.cursor.mixerId, replacement.peerId);
  assert.equal(shadow.cursor.nextSequence, 2);

  const stalePrimary = { ...nextEnvelope(replacement, shadow, 'next'), mixerId: primary.peerId };
  assert.throws(() => shadow.replicate(stalePrimary, NOW), /stale or competing mixer/);
  assert.throws(() => shadow.takeover(grant, authority.publicKeyDer.toString('hex'), NOW), /already used/);
});

test('takeover rejects deterministic signature tampering, wrong domains, and lagging checkpoints', () => {
  const authority = PeerIdentity.generate();
  const primary = PeerIdentity.generate();
  const replacement = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', primary.peerId, primary.publicKeyDer.toString('hex'), { routeEpoch: 4 });
  const grant = takeoverGrant(authority, primary, replacement, shadow);
  const lagging = takeoverGrant(authority, primary, replacement, shadow, {
    grantId: 'grant-lagging',
    lastStateHash: '0'.repeat(64),
  });
  assert.throws(() => shadow.takeover(lagging, authority.publicKeyDer.toString('hex'), NOW), /not exactly replicated/);

  const signature = Buffer.from(grant.signature, 'hex');
  signature[0] = (signature[0] ?? 0) ^ 1;
  assert.throws(
    () => shadow.takeover({ ...grant, signature: signature.toString('hex') }, authority.publicKeyDer.toString('hex'), NOW),
    /signature is invalid/,
  );

  const wrongRoute = takeoverGrant(authority, primary, replacement, shadow, { routeEpoch: 5, grantId: 'wrong-route' });
  assert.throws(() => shadow.takeover(wrongRoute, authority.publicKeyDer.toString('hex'), NOW), /domain does not match/);
});

test('legacy text-primary takeover is allowed only before visible output', () => {
  const authority = PeerIdentity.generate();
  const primary = PeerIdentity.generate();
  const replacement = PeerIdentity.generate();
  const before = new DeterministicShadow('request-before', primary.peerId, primary.publicKeyDer.toString('hex'), { regime: 'text-primary' });
  before.takeover(takeoverGrant(authority, primary, replacement, before), authority.publicKeyDer.toString('hex'), NOW);
  assert.equal(before.cursor.mixerId, replacement.peerId);

  const after = new DeterministicShadow('request-after', primary.peerId, primary.publicKeyDer.toString('hex'), { regime: 'text-primary' });
  after.replicate(nextEnvelope(primary, after, 'visible'), NOW);
  assert.throws(
    () => after.takeover(takeoverGrant(authority, primary, replacement, after), authority.publicKeyDer.toString('hex'), NOW),
    /cannot fail over after visible output/,
  );
});

test('signing rejects non-canonical values and constitutional bounds', () => {
  const mixer = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', mixer.peerId, mixer.publicKeyDer.toString('hex'));
  const base = nextEnvelope(mixer, shadow, 'valid');
  const unsigned = {
    protocolVersion: base.protocolVersion,
    routeEpoch: base.routeEpoch,
    eventId: 'hostile',
    kind: base.kind,
    regime: base.regime,
    requestId: base.requestId,
    mixerEpoch: base.mixerEpoch,
    sequence: base.sequence,
    previousHash: base.previousHash,
    previousStateHash: base.previousStateHash,
    contributionIds: base.contributionIds,
    checkpoint: base.checkpoint,
    issuedAt: base.issuedAt,
    expiresAt: base.expiresAt,
  };
  assert.throws(() => signOutputEnvelope(mixer, { ...unsigned, payload: { x: undefined } }), /canonical JSON/);
  assert.throws(() => signOutputEnvelope(mixer, { ...unsigned, payload: { x: Number.NaN } }), /finite/);
  assert.throws(() => signOutputEnvelope(mixer, { ...unsigned, payload: { x: () => true } }), /canonical JSON/);
  const sparse = new Array(2);
  sparse[1] = 'x';
  assert.throws(() => signOutputEnvelope(mixer, { ...unsigned, payload: sparse }), /sparse/);
  assert.throws(
    () => signOutputEnvelope(mixer, { ...unsigned, payload: { ok: true, [Symbol('hidden')]: 1 } }),
    /symbol keys/,
  );
  assert.throws(
    () => signOutputEnvelope(mixer, { ...unsigned, payload: 'x', expiresAt: base.issuedAt + 60_001 }),
    /bounded validity window/,
  );
  assert.throws(
    () => signOutputEnvelope(mixer, { ...unsigned, payload: 'x', contributionIds: Array.from({ length: 65 }, (_, i) => `f-${i}`) }),
    /exceeds bounds/,
  );
});

test('output route domain is bound before state can be applied', () => {
  const mixer = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', mixer.peerId, mixer.publicKeyDer.toString('hex'), { routeEpoch: 2 });
  const signed = nextEnvelope(mixer, shadow, 'x');
  assert.throws(() => shadow.replicate({ ...signed, routeEpoch: 3 }, NOW), /domain does not match/);
  assert.equal(shadow.cursor.nextSequence, 0);
});

test('checkpoint contributions must be present in authenticated replay state', () => {
  const mixer = PeerIdentity.generate();
  const shadow = new DeterministicShadow('request-1', mixer.peerId, mixer.publicKeyDer.toString('hex'));
  const cursor = shadow.cursor;
  const signed = signOutputEnvelope(mixer, {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    routeEpoch: cursor.routeEpoch,
    eventId: 'missing-contribution',
    kind: 'claim',
    regime: cursor.regime,
    requestId: shadow.requestId,
    mixerEpoch: cursor.mixerEpoch,
    sequence: 0,
    previousHash: cursor.lastEnvelopeHash,
    previousStateHash: cursor.lastStateHash,
    payload: 'x',
    contributionIds: ['not-in-checkpoint'],
    checkpoint: { ...checkpoint(shadow, 'x'), acceptedFrameIds: [] },
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
  });
  assert.throws(() => shadow.replicate(signed, NOW), /absent from checkpoint/);
});
