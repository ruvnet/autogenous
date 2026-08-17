//! External outcome verification before a durable-memory write (ADR-401 Dec 2 /
//! false-consensus invariant).
//!
//! The one false-consensus mitigation with a published effect size is task-outcome
//! verification (+15.6% task success, MAST arXiv:2503.13657) — a high-level check
//! that the outcome is actually good, performed by an agent OTHER than the ones
//! that produced it. This module gates a durable write on exactly that:
//!
//!   • EXTERNAL — a verifier that is one of the outcome's own contributors is
//!     ignored (no self-attestation). Verification must come from outside.
//!   • INDEPENDENT — with lineage supplied, the external affirmers must clear a
//!     graded `effectiveSupport` quorum, so a same-lineage verifier clique can't
//!     rubber-stamp (reuses the lineage independence used everywhere else).
//!   • ADVERSARIAL — a verdict may `refute`; a single VALID external refutation
//!     blocks the write (the outcome must survive challenge, not just collect
//!     affirmations).
//!   • FAIL-CLOSED — no external verifier ⇒ no write.
//!
//! Composable and opt-in: callers hash the outcome, collect signed verdicts, and
//! call `admitDurableWrite` before committing to the trajectory / promoting /
//! updating any durable state. No existing write path is forced to change.

import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';
import {
  DEFAULT_INDEPENDENCE_WEIGHTS,
  effectiveSupport,
  type IndependenceWeights,
  type LineageSupport,
  type ModelLineage,
} from './lineage-independence.js';

export type VerdictStance = 'affirm' | 'refute';

export interface UnsignedOutcomeVerdict {
  /** Hash of the exact outcome being verified (see `outcomeHash`). */
  outcomeHash: string;
  /** The verifier's agent id (must be pinned in the gate's trustedVerifiers). */
  verifierId: string;
  /** affirm = the outcome is sound; refute = the outcome is unsound. */
  stance: VerdictStance;
  /** The verifier's own confidence gate — a stance only counts when verified. */
  verified: boolean;
  reason: string;
}

export interface OutcomeVerdict extends UnsignedOutcomeVerdict {
  /** Ed25519 signature by the verifier's key over the canonical unsigned bytes. */
  signature: string;
}

/** Stable hash of an outcome payload — what verdicts are bound to. */
export function outcomeHash(outcome: unknown): string {
  return createHash('sha256').update(canonicalBytes(outcome)).digest('hex');
}

/** Sign a verdict; the signer id must be the verifier's own agent id. */
export function signOutcomeVerdict(verifier: PeerIdentity, unsigned: UnsignedOutcomeVerdict): OutcomeVerdict {
  if (unsigned.verifierId !== verifier.peerId) throw new TypeError('verdict verifierId must match signer identity');
  return { ...unsigned, signature: verifier.sign(canonicalBytes(unsigned)) };
}

export interface OutcomeGatePolicy {
  /** verifierId -> DER SPKI public key (hex). Only these may verify. */
  trustedVerifiers: Readonly<Record<string, string>>;
  /** The outcome's own producers — excluded from verifying it (externality). */
  contributorIds: readonly string[];
  /** Minimum external, independent affirmations required to admit a write. */
  minAffirmations: number;
  /** Optional graded independence: verifier id -> lineage. */
  lineageOf?: (verifierId: string) => ModelLineage | undefined;
  /** If lineageOf is given, affirmers must reach this effective support. */
  minEffectiveSupport?: number;
  weights?: IndependenceWeights;
}

export type OutcomeRejection =
  | 'no-external-verifier'
  | 'insufficient-affirmation'
  | 'insufficient-independence'
  | 'verifier-equivocation'
  | 'refuted';

export interface OutcomeGateDecision {
  admit: boolean;
  affirmations: number;
  refutations: number;
  /** Present when lineageOf was supplied. */
  effectiveSupport?: number;
  rejection?: OutcomeRejection;
}

function verdictIsAuthentic(v: OutcomeVerdict, hash: string, policy: OutcomeGatePolicy): boolean {
  if (v.outcomeHash !== hash) return false;
  const key = policy.trustedVerifiers[v.verifierId];
  if (!key) return false; // untrusted verifier
  if (policy.contributorIds.includes(v.verifierId)) return false; // not external
  const { signature: _sig, ...unsigned } = v;
  try {
    return edVerify(null, canonicalBytes(unsigned), { key: Buffer.from(key, 'hex'), format: 'der', type: 'spki' }, Buffer.from(v.signature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Admit a durable write iff the outcome has enough external, independent
 * affirmations AND survives adversarial refutation. Fail-closed.
 */
export function admitDurableWrite(
  hash: string,
  verdicts: readonly OutcomeVerdict[],
  policy: OutcomeGatePolicy,
): OutcomeGateDecision {
  const external = verdicts.filter((v) => v.verified && verdictIsAuthentic(v, hash, policy));
  // EQUIVOCATION (order-independent): a verifier that signs CONFLICTING stances
  // for the same outcome is byzantine — its "last vote" must not silently decide
  // the write by array order. Fail closed on the whole outcome. Identical repeat
  // verdicts (same stance) are deduplicated, not equivocation.
  const byVerifier = new Map<string, OutcomeVerdict>();
  let equivocation = false;
  for (const v of external) {
    const prior = byVerifier.get(v.verifierId);
    if (prior && prior.stance !== v.stance) equivocation = true;
    byVerifier.set(v.verifierId, v);
  }
  if (equivocation) return { affirmations: 0, refutations: 0, admit: false, rejection: 'verifier-equivocation' };
  const unique = [...byVerifier.values()];

  const refuters = unique.filter((v) => v.stance === 'refute');
  const affirmers = unique.filter((v) => v.stance === 'affirm');
  const base = { affirmations: affirmers.length, refutations: refuters.length };

  let effective: number | undefined;
  if (policy.lineageOf) {
    const supports: LineageSupport[] = affirmers.map((v) => ({
      agentId: v.verifierId,
      principalId: v.verifierId,
      lineage: policy.lineageOf!(v.verifierId) ?? { provider: 'unknown', arch: 'unknown', sizeClass: 'M', modelId: v.verifierId },
      sourceIds: [],
    }));
    effective = effectiveSupport(supports, policy.weights ?? DEFAULT_INDEPENDENCE_WEIGHTS);
  }
  const withES = effective !== undefined ? { ...base, effectiveSupport: effective } : base;

  if (unique.length === 0) return { ...withES, admit: false, rejection: 'no-external-verifier' };
  if (refuters.length > 0) return { ...withES, admit: false, rejection: 'refuted' };
  if (affirmers.length < policy.minAffirmations) return { ...withES, admit: false, rejection: 'insufficient-affirmation' };
  if (policy.lineageOf && policy.minEffectiveSupport !== undefined && (effective ?? 0) < policy.minEffectiveSupport) {
    return { ...withES, admit: false, rejection: 'insufficient-independence' };
  }
  return { ...withES, admit: true };
}
