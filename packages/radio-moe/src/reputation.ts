//! Signed reputation ledger — a market for machine expertise (ADR-401 cap 9).
//!
//! Peers advertise what they can do (`CapabilityClaim`) and earn reputation ONLY
//! from **externally-verified** contribution — never self-report. A
//! `PerformanceRecord` is valid only when it carries the `OutcomeVerdict`s that
//! passed `admitDurableWrite` (outcome-verifier.ts): reputation therefore accrues
//! from outcomes that independent, external verifiers affirmed, tying cap 9 to the
//! false-consensus guard rather than to brand claims.
//!
//! HONEST LABEL — the `selectionWeight` form `w = (q·t·r)/(c·l)` (quality · trust ·
//! relevance ÷ cost · latency) is an **UNVALIDATED in-house hypothesis**: the
//! scoped research (docs/research/2026-08-16-pim-new-angles.md) found ZERO
//! literature backing for it. It is exported so it can be measured, not because it
//! is proven. Do not present it as a validated mechanism.

import { verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';
import { admitDurableWrite, type OutcomeGatePolicy, type OutcomeVerdict } from './outcome-verifier.js';

/** A signed advertisement of what a peer can do (published, not trusted blindly). */
export interface UnsignedCapabilityClaim {
  agentId: string;
  capability: string;
  /** The peer's own advertised quality in [0, 1] — a claim, corrected by reputation. */
  advertisedQuality: number;
  issuedAt: number;
}
export interface CapabilityClaim extends UnsignedCapabilityClaim {
  signature: string;
}

export function signCapabilityClaim(peer: PeerIdentity, claim: UnsignedCapabilityClaim): CapabilityClaim {
  if (claim.agentId !== peer.peerId) throw new TypeError('capability claim agentId must match signer');
  return { ...claim, signature: peer.sign(canonicalBytes(claim)) };
}
export function verifyCapabilityClaim(claim: CapabilityClaim, publicKeyDerHex: string): boolean {
  const { signature, ...unsigned } = claim;
  return verifyDetached(canonicalBytes(unsigned), signature, publicKeyDerHex);
}

/** A record that an agent contributed to an outcome that was EXTERNALLY VERIFIED.
 *  Carries the affirming verdicts so validity is provable, not self-asserted. */
export interface UnsignedPerformanceRecord {
  agentId: string;
  /** Hash of the verified outcome (outcomeHash from outcome-verifier). */
  outcomeHash: string;
  /** Measured quality of the contribution in [0, 1]. */
  quality: number;
  /** The external verdicts that admitted the outcome (proof of verification). */
  verdicts: readonly OutcomeVerdict[];
  issuedAt: number;
}
export interface PerformanceRecord extends UnsignedPerformanceRecord {
  signature: string;
}

/**
 * Mint a performance record ONLY if the referenced outcome passes external
 * verification (`admitDurableWrite`) with this agent among the contributors.
 * Returns null when the outcome was not externally verified — no reputation is
 * earned from an unverified outcome.
 */
export function mintPerformanceRecord(
  peer: PeerIdentity,
  outcomeHash: string,
  quality: number,
  verdicts: readonly OutcomeVerdict[],
  policy: OutcomeGatePolicy,
  now: number,
): PerformanceRecord | null {
  if (!policy.contributorIds.includes(peer.peerId)) return null; // must be a contributor
  if (!admitDurableWrite(outcomeHash, verdicts, policy).admit) return null; // must be externally verified
  const unsigned: UnsignedPerformanceRecord = {
    agentId: peer.peerId,
    outcomeHash,
    quality: clampUnit(quality),
    verdicts,
    issuedAt: now,
  };
  return { ...unsigned, signature: peer.sign(canonicalBytes(unsigned)) };
}

/**
 * Verify a performance record: the agent's signature is valid AND the carried
 * verdicts still admit the outcome under `policy` with this agent as a
 * contributor. A forged or self-reported record (missing/insufficient external
 * verdicts) fails.
 */
export function verifyPerformanceRecord(
  record: PerformanceRecord,
  agentPublicKeyDerHex: string,
  policy: OutcomeGatePolicy,
): boolean {
  const { signature, ...unsigned } = record;
  if (!verifyDetached(canonicalBytes(unsigned), signature, agentPublicKeyDerHex)) return false;
  if (!policy.contributorIds.includes(record.agentId)) return false;
  return admitDurableWrite(record.outcomeHash, record.verdicts, policy).admit;
}

export interface Reputation {
  agentId: string;
  /** Count of distinct externally-verified outcomes this agent contributed to. */
  verifiedContributions: number;
  /** Mean measured quality over verified contributions in [0, 1] (0 if none). */
  meanQuality: number;
}

/**
 * Aggregate an agent's reputation from ONLY the records that verify (signature +
 * external verification). Unverified/self-reported records are ignored.
 */
export function reputation(
  agentId: string,
  records: readonly PerformanceRecord[],
  agentPublicKeyDerHex: string,
  policy: OutcomeGatePolicy,
): Reputation {
  const valid = records.filter(
    (r) => r.agentId === agentId && verifyPerformanceRecord(r, agentPublicKeyDerHex, policy),
  );
  const outcomes = new Set(valid.map((r) => r.outcomeHash));
  const meanQuality = valid.length ? valid.reduce((s, r) => s + r.quality, 0) / valid.length : 0;
  return { agentId, verifiedContributions: outcomes.size, meanQuality: round(meanQuality) };
}

export interface SelectionInputs {
  quality: number;
  trust: number;
  relevance: number;
  cost: number;
  latency: number;
}

/**
 * UNVALIDATED HYPOTHESIS (see module header): `w = (q·t·r)/(c·l)`. Exported so an
 * expertise market could rank peers by marginal value — but the form has NO
 * literature backing and MUST be treated as a tunable hypothesis to be measured,
 * not a proven mechanism. Guards against divide-by-zero with a small epsilon.
 */
export function selectionWeight({ quality, trust, relevance, cost, latency }: SelectionInputs): number {
  const eps = 1e-6;
  return (clampUnit(quality) * clampUnit(trust) * clampUnit(relevance)) / (Math.max(eps, cost) * Math.max(eps, latency));
}

const clampUnit = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round = (x: number): number => Math.round(x * 1e6) / 1e6;
function verifyDetached(bytes: Buffer, signatureHex: string, publicKeyDerHex: string): boolean {
  try {
    return edVerify(null, bytes, { key: Buffer.from(publicKeyDerHex, 'hex'), format: 'der', type: 'spki' }, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
