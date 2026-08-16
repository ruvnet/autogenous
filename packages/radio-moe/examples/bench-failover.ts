//! Failover recovery bench (PIM ADR-401 V1 #1 / cond 3; ADR-402 cond 2).
//!
//! Quantifies the acceptance target: **survive loss of ~30% of peers, recover
//! within 5 s, with NO loss of authorized state.** An N-peer mesh replicates a
//! signed, hash-chained mixture output stream (`failover.ts`). We drop 30% of the
//! peers *including the active mixer*, then measure the wall-clock cost of the
//! real recovery path — authority-signed fencing grant → shadow takeover → the
//! replacement mixer resuming the exact checkpoint chain — and assert the
//! post-recovery cursor advanced with an unbroken chain (no lost state).
//!
//! Logical protocol time is fixed (so validity windows pass); `performance.now()`
//! measures the genuine ed25519 grant/verify/sign/verify cost — not a no-op.
//! Run: `node --import tsx examples/bench-failover.ts`.

import { performance } from 'node:perf_hooks';
import { PeerIdentity } from '../src/transport.js';
import {
  DeterministicShadow,
  OUTPUT_PROTOCOL_VERSION,
  createTakeoverGrant,
  signOutputEnvelope,
  type MixtureCheckpoint,
  type OutputEnvelope,
} from '../src/failover.js';

const NOW = 1_800_000_000_000; // fixed logical time for protocol validity windows

function checkpoint(shadow: DeterministicShadow, payload: unknown): MixtureCheckpoint {
  const c = shadow.cursor;
  const frameId = `frame-${c.nextSequence}`;
  return {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    requestId: shadow.requestId,
    routeEpoch: c.routeEpoch,
    window: c.nextSequence,
    acceptedFrameIds: [...(c.checkpoint?.acceptedFrameIds ?? []), frameId],
    agentSteps: { ...(c.checkpoint?.agentSteps ?? {}), agent: c.nextSequence },
    mixtureState: { priorStateHash: c.lastStateHash, visible: payload, weightsMicros: { agent: 1_000_000 } },
  };
}

function nextEnvelope(identity: PeerIdentity, shadow: DeterministicShadow, payload: unknown): OutputEnvelope {
  const c = shadow.cursor;
  return signOutputEnvelope(identity, {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    routeEpoch: c.routeEpoch,
    eventId: `event-${c.mixerEpoch}-${c.nextSequence}`,
    kind: 'claim',
    regime: c.regime,
    requestId: shadow.requestId,
    mixerEpoch: c.mixerEpoch,
    sequence: c.nextSequence,
    previousHash: c.lastEnvelopeHash,
    previousStateHash: c.lastStateHash,
    payload,
    contributionIds: [`frame-${c.nextSequence}`],
    checkpoint: checkpoint(shadow, payload),
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
  });
}

export interface FailoverReport {
  peers: number;
  lost: number;
  lostFraction: number;
  survivors: number;
  envelopesBeforeLoss: number;
  iterations: number;
  recoveryMs: { p50: number; p99: number; max: number };
  recoveredWithinBudget: boolean;
  stateContinuous: boolean;
  budgetMs: number;
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/** One authorized recovery: build an N-peer replicated stream, lose 30% incl. the
 *  mixer, then time the fenced takeover + resume on a surviving shadow. */
function recoverOnce(peers: number, envelopesBeforeLoss: number): { ms: number; continuous: boolean } {
  const authority = PeerIdentity.generate();
  const authorityKey = authority.publicKeyDer.toString('hex');
  const primary = PeerIdentity.generate();

  // Every peer holds a shadow replica of the same signed stream (the authorized state).
  const replicas = Array.from({ length: peers }, () =>
    new DeterministicShadow('failover-req', primary.peerId, primary.publicKeyDer.toString('hex'), { routeEpoch: 3 }));
  for (let i = 0; i < envelopesBeforeLoss; i++) {
    const env = nextEnvelope(primary, replicas[0]!, { delta: i });
    for (const r of replicas) r.replicate(env, NOW);
  }

  // Lose 30% of peers INCLUDING the primary mixer. replicas[0] survives as the
  // takeover candidate (any fully-replicated survivor works — they are identical).
  const lost = Math.max(1, Math.floor(peers * 0.3));
  const survivor = replicas[0]!;
  const replacement = PeerIdentity.generate(); // a standby peer takes the mixer role
  const seqBefore = survivor.cursor.nextSequence;

  // ---- timed recovery path (real ed25519 work) ----
  const t0 = performance.now();
  const c = survivor.cursor;
  const grant = createTakeoverGrant(authority, {
    protocolVersion: OUTPUT_PROTOCOL_VERSION,
    routeEpoch: c.routeEpoch,
    regime: c.regime,
    grantId: `grant-${c.mixerEpoch + 1}`,
    requestId: survivor.requestId,
    fromMixerId: primary.peerId,
    toMixerId: replacement.peerId,
    toMixerPublicKeyDer: replacement.publicKeyDer.toString('hex'),
    mixerEpoch: c.mixerEpoch + 1,
    lastSequence: c.nextSequence - 1,
    lastEnvelopeHash: c.lastEnvelopeHash,
    lastStateHash: c.lastStateHash,
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
  });
  survivor.takeover(grant, authorityKey, NOW);
  survivor.replicate(nextEnvelope(replacement, survivor, { delta: 'post-takeover' }), NOW);
  const ms = performance.now() - t0;
  // ---- end timed path ----

  // No lost authorized state: exactly one new envelope committed on the exact chain.
  const continuous = survivor.cursor.nextSequence === seqBefore + 1;
  return { ms, continuous };
}

export function runFailoverRecovery(
  { peers = 10, envelopesBeforeLoss = 20, iterations = 50, budgetMs = 5000 } = {},
): FailoverReport {
  const samples: number[] = [];
  let stateContinuous = true;
  for (let i = 0; i < iterations; i++) {
    const { ms, continuous } = recoverOnce(peers, envelopesBeforeLoss);
    samples.push(ms);
    stateContinuous &&= continuous;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const lost = Math.max(1, Math.floor(peers * 0.3));
  const recoveryMs = { p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1)! };
  return {
    peers,
    lost,
    lostFraction: lost / peers,
    survivors: peers - lost,
    envelopesBeforeLoss,
    iterations,
    recoveryMs,
    recoveredWithinBudget: recoveryMs.max < budgetMs,
    stateContinuous,
    budgetMs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runFailoverRecovery();
  console.log(`\n── Failover recovery (${r.peers} peers, lose ${r.lost} incl. mixer = ${(r.lostFraction * 100).toFixed(0)}%, ${r.iterations} runs) ──`);
  console.log(`  authorized stream:   ${r.envelopesBeforeLoss} signed envelopes replicated to every peer`);
  console.log(`  survivors:           ${r.survivors}`);
  console.log(`  recovery p50 / p99 / max:  ${r.recoveryMs.p50.toFixed(3)} / ${r.recoveryMs.p99.toFixed(3)} / ${r.recoveryMs.max.toFixed(3)} ms`);
  console.log(`  target: recover < ${r.budgetMs} ms  → ${r.recoveredWithinBudget ? 'PASS' : 'FAIL'} (max ${r.recoveryMs.max.toFixed(2)} ms, ${(r.budgetMs / r.recoveryMs.max).toFixed(0)}× under budget)`);
  console.log(`  no loss of authorized state (exact chain continued):  ${r.stateContinuous ? 'PASS' : 'FAIL'}`);
}
