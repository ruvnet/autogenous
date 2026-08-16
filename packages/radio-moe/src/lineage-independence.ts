//! Graded model-lineage independence + counter-signing completion certs —
//! implemented to the design the mesh's own reviewer expert produced
//! (dogfood-1), grounded in the correlated-errors research (ICML 2025,
//! arXiv:2506.07962): same provider/architecture/size significantly predict
//! agreeing on the SAME wrong answer (~60% vs 1/3 baseline; llama-3.2-90b vs
//! llama-3.1-70b agree 0.97 when both wrong) — so binary distinct-modelId
//! independence over-counts.
//!
//! ⚠ TUNABLE, NEVER FROZEN: the research pass left UNVERIFIED whether more-
//! accurate models correlate even across providers/architectures (all 3
//! verifier votes errored). Until that is independently checked, these weights
//! are configuration, not constants — see docs/research/2026-08-16-…sota.md.

import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalBytes, type AgentFrame } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';

export interface ModelLineage {
  provider: string;
  arch: string;
  sizeClass: 'S' | 'M' | 'L' | 'XL';
  modelId: string;
}

export interface LineageSupport {
  agentId: string;
  principalId: string;
  lineage: ModelLineage;
  sourceIds: readonly string[];
}

/** Penalty weights (defaults from the dogfood reviewer design). Tunable. */
export interface IndependenceWeights {
  sameProvider: number;
  sameArch: number;
  sameSize: number;
  sourceJaccard: number;
}

export const DEFAULT_INDEPENDENCE_WEIGHTS: IndependenceWeights = {
  sameProvider: 0.4,
  sameArch: 0.35,
  sameSize: 0.1,
  sourceJaccard: 0.15,
};

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** Pairwise independence in [0,1]: 0 for identical models; graded penalties for
 *  shared provider/arch/size and overlapping evidence. */
export function pairIndependence(
  a: LineageSupport,
  b: LineageSupport,
  w: IndependenceWeights = DEFAULT_INDEPENDENCE_WEIGHTS,
): number {
  if (a.lineage.modelId === b.lineage.modelId) return 0;
  let s = 1;
  if (a.lineage.provider === b.lineage.provider) s -= w.sameProvider;
  if (a.lineage.arch === b.lineage.arch) s -= w.sameArch;
  if (a.lineage.sizeClass === b.lineage.sizeClass) s -= w.sameSize;
  s -= w.sourceJaccard * jaccard(a.sourceIds, b.sourceIds);
  return Math.max(0, s);
}

/**
 * Effective independent support of a set: greedily add the supporter that
 * maximizes its MINIMUM pairwise independence to those already selected; each
 * addition contributes that minimum (first supporter contributes 1). Replaces
 * "count >= 2 distinct modelIds" with a graded quantity comparable to a quorum
 * threshold (e.g. require >= 2.0).
 */
export function effectiveSupport(
  supports: readonly LineageSupport[],
  w: IndependenceWeights = DEFAULT_INDEPENDENCE_WEIGHTS,
): number {
  if (supports.length === 0) return 0;
  const remaining = [...supports];
  // Deterministic start: lexicographically smallest agentId.
  remaining.sort((x, y) => (x.agentId < y.agentId ? -1 : 1));
  const chosen: LineageSupport[] = [remaining.shift()!];
  let total = 1;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMin = -1;
    remaining.forEach((cand, i) => {
      const min = Math.min(...chosen.map((c) => pairIndependence(cand, c, w)));
      if (min > bestMin) {
        bestMin = min;
        bestIdx = i;
      }
    });
    const [next] = remaining.splice(bestIdx, 1);
    chosen.push(next!);
    total += Math.max(0, bestMin);
  }
  return total;
}

/** k-of-n counter-signing completion certificate (dogfood reviewer design):
 *  a completion frame counts as evidence only when k designated verifiers
 *  counter-sign its canonical bytes — and the signers THEMSELVES must meet a
 *  minimum pairwise independence, so a same-lineage clique can't self-quorum.
 *  Closes AIP's conceded self-reported-completions gap. */
export interface CompletionCert {
  frameHash: string;
  signers: readonly string[]; // DER SPKI public keys (hex), aligned with sigs
  sigs: readonly string[];
  lineages: readonly ModelLineage[]; // aligned; used for clique resistance
}

function frameHash(frame: AgentFrame): string {
  return createHash('sha256').update(canonicalBytes(frame)).digest('hex');
}

/** Bytes a counter-signature covers: frameHash ‖ signer pubkey ‖ canonical
 *  lineage. Binding the signer's OWN key and lineage into the signed message
 *  (mesh-review finding, dogfood-review-1) means a cert assembler cannot
 *  fabricate lineages or replay another signer's signature under a different
 *  identity — each attestation attests its lineage, not just the frame. */
function attestationBytes(fh: string, signerPubHex: string, lineage: ModelLineage): Buffer {
  return Buffer.concat([
    Buffer.from(fh),
    Buffer.from(signerPubHex),
    canonicalBytes(lineage),
  ]);
}

/** A verifier counter-signs the frame hash bound to ITS key + lineage. */
export function counterSign(verifier: PeerIdentity, frame: AgentFrame, lineage: ModelLineage): string {
  return verifier.sign(attestationBytes(frameHash(frame), verifier.publicKeyDer.toString('hex'), lineage));
}

export const MAX_CERT_SIGNERS = 16;

export function buildCert(
  frame: AgentFrame,
  attestations: { identity: PeerIdentity; lineage: ModelLineage }[],
): CompletionCert {
  if (attestations.length > MAX_CERT_SIGNERS) throw new Error('too many signers');
  return {
    frameHash: frameHash(frame),
    signers: attestations.map((a) => a.identity.publicKeyDer.toString('hex')),
    sigs: attestations.map((a) => counterSign(a.identity, frame, a.lineage)),
    lineages: attestations.map((a) => a.lineage),
  };
}

export interface CertPolicy {
  k: number;
  /** Minimum pairwise independence among the counting signers. */
  minPairIndependence: number;
  weights?: IndependenceWeights;
}

/** Verify: hash matches; per-attestation signatures (bound to signer key +
 *  lineage) from DISTINCT signers; and SOME k-subset of the valid signers meets
 *  the minimum pairwise independence. Both fixes are mesh-review findings
 *  (dogfood-review-1): lineage is now attested (no fabricated-lineage /
 *  duplicated-signature quorum), and one correlated extra signer no longer
 *  falsely rejects a cert containing an independent k-subset. */
export function verifyCert(cert: CompletionCert, frame: AgentFrame, policy: CertPolicy): boolean {
  const fh = frameHash(frame);
  if (fh !== cert.frameHash) return false;
  if (
    cert.signers.length !== cert.sigs.length ||
    cert.signers.length !== cert.lineages.length ||
    cert.signers.length > MAX_CERT_SIGNERS
  ) {
    return false;
  }
  const seenSigners = new Set<string>();
  const valid: ModelLineage[] = [];
  cert.signers.forEach((keyHex, i) => {
    if (seenSigners.has(keyHex)) return; // duplicated signer counts ONCE
    try {
      const ok = edVerify(
        null,
        attestationBytes(fh, keyHex, cert.lineages[i]!),
        { key: Buffer.from(keyHex, 'hex'), format: 'der', type: 'spki' },
        Buffer.from(cert.sigs[i]!, 'hex'),
      );
      if (ok) {
        seenSigners.add(keyHex);
        valid.push(cert.lineages[i]!);
      }
    } catch {
      /* invalid key/sig — not counted */
    }
  });
  if (valid.length < policy.k) return false;
  const w = policy.weights ?? DEFAULT_INDEPENDENCE_WEIGHTS;
  const sup = (l: ModelLineage, i: number): LineageSupport => ({
    agentId: `s${i}`,
    principalId: '',
    lineage: l,
    sourceIds: [],
  });
  // Accept if ANY k-subset is pairwise independent (n ≤ 16 → subsets bounded).
  const idx = valid.map((_, i) => i);
  const choose = (start: number, chosen: number[]): boolean => {
    if (chosen.length === policy.k) {
      for (let a = 0; a < chosen.length; a++) {
        for (let b = a + 1; b < chosen.length; b++) {
          if (
            pairIndependence(sup(valid[chosen[a]!]!, chosen[a]!), sup(valid[chosen[b]!]!, chosen[b]!), w) <
            policy.minPairIndependence
          ) {
            return false;
          }
        }
      }
      return true;
    }
    for (let i = start; i < idx.length; i++) {
      if (choose(i + 1, [...chosen, i])) return true;
    }
    return false;
  };
  return choose(0, []);
}
