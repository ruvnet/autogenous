//! Sovereign-peer disclosure boundary (ADR-401 capability 6, disclosure half).
//!
//! Organizations cooperate WITHOUT pooling raw data: each sovereign peer discloses
//! **signed findings, confidence, and permitted evidence references** — never raw
//! sensor streams or above-ceiling evidence. Research (docs/research/
//! 2026-08-16-pim-new-angles.md) confirmed this disclosure half is deployable
//! (Cyber Threat Alliance moves ~10M signed-attribution observables/month) — and
//! that a *cryptographically signed* disclosure carrying a *numeric confidence* is
//! AHEAD of that deployed practice (CTA has neither). This module is that boundary.
//!
//! Fail-closed by construction: a `Disclosure` can only carry the claim, a clamped
//! confidence, and evidence DIGESTS (sha256 references) for evidence at or below
//! the policy's privacy ceiling. Raw payloads and the internal `raw` field never
//! enter the disclosed shape — there is no field to leak them through.

import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';
import type { PrivacyClass } from './observation.js';

const PRIVACY_ORDER: Record<PrivacyClass, number> = { public: 0, internal: 1, restricted: 2, sensitive: 3 };

/** An internal evidence item — its `payload` stays local and is NEVER disclosed. */
export interface EvidenceItem {
  id: string;
  privacyClass: PrivacyClass;
  payload: unknown;
}

/** A finding as it exists INSIDE the sovereign peer (with raw data). */
export interface InternalFinding {
  claim: string;
  confidence: number;
  evidence: readonly EvidenceItem[];
  /** Any raw/internal detail — NEVER disclosed. */
  raw?: unknown;
}

export interface DisclosurePolicy {
  /** Only evidence at or below this privacy class may be referenced. */
  maxPrivacyClass: PrivacyClass;
  /** Whether to include evidence references at all (default true). */
  discloseEvidenceRefs?: boolean;
}

/** A disclosed evidence reference — a digest, never the payload. */
export interface DisclosedEvidenceRef {
  id: string;
  privacyClass: PrivacyClass;
  /** sha256 of the canonical payload — proves reference without revealing it. */
  digest: string;
}

export interface UnsignedDisclosure {
  claim: string;
  confidence: number;
  /** The disclosing peer's identity. */
  disclosedBy: string;
  /** The privacy ceiling this disclosure was produced under. */
  privacyCeiling: PrivacyClass;
  /** Evidence digests at or below the ceiling — no payloads. */
  evidenceRefs: readonly DisclosedEvidenceRef[];
  issuedAt: number;
}

export interface Disclosure extends UnsignedDisclosure {
  /** Ed25519 signature by the discloser — provenance the receiver can verify. */
  signature: string;
}

const clampUnit = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** sha256 of an evidence item's canonical payload (a reference, not the payload). */
export function evidenceDigest(item: EvidenceItem): string {
  return createHash('sha256').update(canonicalBytes(item.payload)).digest('hex');
}

/**
 * Produce a signed disclosure carrying ONLY permitted fields: the claim, a clamped
 * confidence, and evidence digests at/below the policy ceiling. Raw payloads and
 * above-ceiling evidence never cross the boundary (fail-closed — the disclosed
 * shape has no field for them).
 */
export function discloseFinding(
  identity: PeerIdentity,
  finding: InternalFinding,
  policy: DisclosurePolicy,
  now: number,
): Disclosure {
  const ceiling = PRIVACY_ORDER[policy.maxPrivacyClass];
  const refs: DisclosedEvidenceRef[] = (policy.discloseEvidenceRefs ?? true)
    ? finding.evidence
        .filter((e) => PRIVACY_ORDER[e.privacyClass] <= ceiling)
        .map((e) => ({ id: e.id, privacyClass: e.privacyClass, digest: evidenceDigest(e) }))
    : [];
  const unsigned: UnsignedDisclosure = {
    claim: finding.claim,
    confidence: clampUnit(finding.confidence),
    disclosedBy: identity.peerId,
    privacyCeiling: policy.maxPrivacyClass,
    evidenceRefs: refs,
    issuedAt: now,
  };
  return { ...unsigned, signature: identity.sign(canonicalBytes(unsigned)) };
}

/** Verify a disclosure's signature against the disclosing peer's pinned key. */
export function verifyDisclosure(d: Disclosure, publicKeyDerHex: string): boolean {
  const { signature, ...unsigned } = d;
  try {
    return edVerify(null, canonicalBytes(unsigned), { key: Buffer.from(publicKeyDerHex, 'hex'), format: 'der', type: 'spki' }, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Receiver/auditor guard: a disclosure must reference no evidence above its
 * declared ceiling. Catches a maliciously-assembled over-disclosure even though
 * `discloseFinding` cannot produce one.
 */
export function assertWithinCeiling(d: Disclosure): boolean {
  const ceiling = PRIVACY_ORDER[d.privacyCeiling];
  return d.evidenceRefs.every((r) => PRIVACY_ORDER[r.privacyClass] <= ceiling);
}
