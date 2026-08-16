//! Lineage-weighted fusion decision (ADR-401 cap 3 / false-consensus invariant).
//!
//! The `MixtureState` snapshot fuses claims by coefficient-weighted support after
//! `selectIndependent` collapses support that shares sourceIds/evidence. The
//! `bench-fusion` benchmark proved that guard is NECESSARY but NOT SUFFICIENT: a
//! confidently-wrong same-lineage cluster (e.g. three llama models) survives
//! sourceId de-dup as a single high-score vote and can still outscore a correct
//! minority — dragging the fused answer below the strongest single expert.
//!
//! This module closes that gap WITHOUT touching the frozen mixture/security core:
//! it re-resolves the winning claim over a snapshot by `effectiveSupport` — greedy
//! min-pairwise independence over each claim's supporters' MODEL LINEAGE (provider/
//! arch/size), so N correlated supporters count far less than N independent ones.
//! Lineage is deployment configuration (who each expert is), supplied by a
//! resolver — never per-frame data — so no signed-contribution schema changes.
//!
//! Fail-closed default: an agent with UNKNOWN lineage is treated as sharing an
//! 'unknown' provider/arch bucket, so unknown provenance never *grants*
//! independence (multiple unknowns are heavily discounted, not counted as
//! independent voters).

import type { MixtureSnapshot } from './mixture.js';
import {
  DEFAULT_INDEPENDENCE_WEIGHTS,
  effectiveSupport,
  type IndependenceWeights,
  type LineageSupport,
  type ModelLineage,
} from './lineage-independence.js';

export interface LineageDecision {
  /** Winning claim by lineage-weighted effective support, or null if no support. */
  claimId: string | null;
  /** The winner's effective independent support (comparable to a quorum threshold). */
  effectiveSupport: number;
  /** The winner's coefficient-fusion net weight (tie-break / audit). */
  netWeight: number;
}

/** Resolve an agent id to its model lineage; undefined ⇒ fail-closed unknown bucket. */
export type LineageResolver = (agentId: string) => ModelLineage | undefined;

/** Build a resolver from a static registry (deployment config). */
export function lineageRegistry(registry: Readonly<Record<string, ModelLineage>>): LineageResolver {
  return (agentId: string) => registry[agentId];
}

function unknownLineage(agentId: string): ModelLineage {
  // Same provider/arch/size bucket for all unknowns ⇒ pairIndependence heavily
  // discounts them; distinct modelId keeps two different unknown agents from
  // collapsing to zero. Net: unknown provenance is conservative, never a
  // free independence grant.
  return { provider: 'unknown', arch: 'unknown', sizeClass: 'M', modelId: `unknown:${agentId}` };
}

/**
 * Re-resolve the fused winner of a mixture snapshot by lineage-weighted
 * effective support. Considers only `support` contributions in the append-only
 * audit; ties break by coefficient net weight, then claimId (deterministic).
 */
export function lineageWeightedWinner(
  snapshot: MixtureSnapshot,
  lineageOf: LineageResolver,
  weights: IndependenceWeights = DEFAULT_INDEPENDENCE_WEIGHTS,
): LineageDecision {
  const supportersByClaim = new Map<string, LineageSupport[]>();
  for (const c of snapshot.audit) {
    if (c.relation !== 'support') continue;
    const lineage = lineageOf(c.agentId) ?? unknownLineage(c.agentId);
    const supporters = supportersByClaim.get(c.claimId) ?? [];
    supporters.push({ agentId: c.agentId, principalId: 'p', lineage, sourceIds: c.sourceIds });
    supportersByClaim.set(c.claimId, supporters);
  }
  const netOf = new Map(snapshot.claims.map((cl) => [cl.claimId, cl.netWeight]));

  let best: LineageDecision = { claimId: null, effectiveSupport: -1, netWeight: -Infinity };
  for (const claimId of [...supportersByClaim.keys()].sort()) {
    const es = effectiveSupport(supportersByClaim.get(claimId)!, weights);
    const net = netOf.get(claimId) ?? 0;
    if (es > best.effectiveSupport || (es === best.effectiveSupport && net > best.netWeight)) {
      best = { claimId, effectiveSupport: es, netWeight: net };
    }
  }
  return best;
}
