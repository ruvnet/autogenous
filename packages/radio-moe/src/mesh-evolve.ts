//! Self-evolving mesh — the autogenous loop applied to the mesh's OWN tunables.
//!
//! ADR-396's boundary, enforced in code: evolution may propose changes to
//! **ranking/independence weights and thresholds inside constitutional
//! ceilings** — it may NEVER touch signature/replay/sequence checks, the
//! fail-closed semantics, or the hard gates themselves. The gates are frozen
//! constants here; parameters are clamped to ceilings on every mutation.
//!
//! Flywheel pattern (metaharness ADR-322 / kimi-k3-harness): run → measure →
//! mutate → verify → promote, with a FROZEN CONJUNCTIVE GATE (beats-champion
//! by a margin AND every hard gate passes) and an immutable, ed25519-signed,
//! hash-chained generation ledger. Deterministic: a seeded LCG replaces
//! Math.random, so any champion is replayable from (seed, generations).

import { DEFAULT_INDEPENDENCE_WEIGHTS, effectiveSupport, type IndependenceWeights, type LineageSupport, type ModelLineage } from './lineage-independence.js';
import { RelevanceScorer } from './relevance.js';
import { signFrame, verifyFrame, type AgentFrame } from './agent-frame.js';
import { packageTrajectory, verifyTrajectory, type PackagedTrajectory } from './rvf-trajectory.js';
import type { PeerIdentity } from './transport.js';

/** The ONLY evolvable surface (ADR-396 "Autogenous may propose changes to…"). */
export interface EvolvableParams {
  weights: IndependenceWeights;
  /** Quorum threshold on effectiveSupport (constitutionally ≥ MIN_QUORUM). */
  quorumThreshold: number;
}

/** Constitutional ceilings — NOT evolvable, clamped on every mutation. */
export const CEILINGS = {
  weightMin: 0.0,
  weightMax: 0.8,
  quorumMin: 1.5,
  quorumMax: 4.0,
} as const;

/** Frozen hard gates (min-semantics — one miss disqualifies, ADR-392). */
const HARD = {
  /** A same-family 3-stack must NEVER reach quorum 2. */
  familyStackCeiling: 2.0,
  /** A genuinely diverse pair must still clear ~2 votes. */
  diversePairFloor: 1.7,
  /** Relevance: on-topic must beat off-topic by at least this factor. */
  topicSeparationFloor: 4,
} as const;

// ── deterministic PRNG (LCG) — replayable evolution, no Math.random ──────────
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const L = (provider: string, arch: string, sizeClass: ModelLineage['sizeClass'], modelId: string): ModelLineage =>
  ({ provider, arch, sizeClass, modelId });
const S = (agentId: string, lineage: ModelLineage): LineageSupport =>
  ({ agentId, principalId: 'p', lineage, sourceIds: [] });

/** The fixed evaluation corpus — the flywheel's stable bench (never mutated). */
const FAMILY_STACK = [
  S('a', L('meta', 'llama', 'XL', 'llama-3.2-90b')),
  S('b', L('meta', 'llama', 'L', 'llama-3.1-70b')),
  S('c', L('meta', 'llama', 'M', 'llama-3-8b')),
];
const DIVERSE_PAIR = [
  S('a', L('meta', 'llama', 'XL', 'llama-3.2-90b')),
  S('b', L('google', 'gemini', 'L', 'gemini-3.7-flash')),
];
const MIXED_TRIO = [
  S('a', L('anthropic', 'claude', 'XL', 'opus-5')),
  S('b', L('google', 'gemini', 'L', 'gemini-3.7-flash')),
  S('c', L('google', 'gemini', 'M', 'gemini-3.5')),
];

export interface Fitness {
  /** Separation between diverse quorums and correlated stacks (maximize). */
  separation: number;
  familyStack: number;
  diversePair: number;
  topicRatio: number;
  hardGatesPass: boolean;
}

/** Deterministic fitness on the frozen bench. Hard gates use min-semantics. */
export function evaluate(params: EvolvableParams): Fitness {
  const familyStack = effectiveSupport(FAMILY_STACK, params.weights);
  const diversePair = effectiveSupport(DIVERSE_PAIR, params.weights);
  const mixedTrio = effectiveSupport(MIXED_TRIO, params.weights);

  const scorer = new RelevanceScorer('why keep routing and authority separate in an agent mesh?');
  const on = scorer.score(mkFrame('on', 'separating routing from authority keeps the agent mesh safe'));
  const off = scorer.score(mkFrame('off', 'my favourite pastry recipe involves croissants and butter'));
  const topicRatio = off > 0 ? on / off : on > 0 ? Infinity : 0;

  // Separation: diverse support clears the threshold while stacks stay below it.
  const separation =
    (diversePair - params.quorumThreshold) +
    (params.quorumThreshold - familyStack) +
    0.25 * (mixedTrio - familyStack);

  const hardGatesPass =
    familyStack < HARD.familyStackCeiling &&
    diversePair >= HARD.diversePairFloor &&
    topicRatio >= HARD.topicSeparationFloor &&
    params.quorumThreshold > familyStack && // stack can never quorum
    params.quorumThreshold <= diversePair; // diversity still can

  return { separation, familyStack, diversePair, topicRatio, hardGatesPass };
}

function mkFrame(agentId: string, value: string): AgentFrame {
  return {
    requestId: 'bench', agentId, step: 0, kind: 'claim', value,
    confidence: 0.5, uncertainty: 0.5, dependencies: [], capabilityUsed: 'x',
    evidenceHashes: [], cost: 0, signature: 'bench-only',
  };
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Bounded mutation: jitter one or two knobs, clamped to the ceilings. */
export function mutate(parent: EvolvableParams, rnd: () => number): EvolvableParams {
  const w = { ...parent.weights };
  // Only the four REQUIRED weight knobs mutate; sameAccuracyBand stays at its
  // configured value until the accuracy-band axis gets its own evolution bench.
  const keys = ['sameProvider', 'sameArch', 'sameSize', 'sourceJaccard'] as const;
  const k = keys[Math.floor(rnd() * keys.length)]!;
  w[k] = clamp(w[k] + (rnd() - 0.5) * 0.2, CEILINGS.weightMin, CEILINGS.weightMax);
  const quorumThreshold =
    rnd() < 0.5
      ? clamp(parent.quorumThreshold + (rnd() - 0.5) * 0.3, CEILINGS.quorumMin, CEILINGS.quorumMax)
      : parent.quorumThreshold;
  return { weights: w, quorumThreshold };
}

/** Frozen conjunctive promotion gate: hard gates AND beats-champion by margin.
 *  This is the Better∧Safe core; the full governed invariant is `promoteAuthorized`. */
export const PROMOTION_MARGIN = 0.02;
export function promotable(candidate: Fitness, champion: Fitness): boolean {
  return candidate.hardGatesPass && candidate.separation >= champion.separation + PROMOTION_MARGIN;
}

/** The two non-fitness conjuncts a promotion needs, supplied by the caller.
 *  `authorized`: this promotion is permitted by policy (in-repo flywheel: the
 *  governed loop within constitutional ceilings; external: a valid human/anchor
 *  authorization). `reversible`: a rollback target is retained so the promotion
 *  can be undone (the signed champion history / ledger). */
export interface PromotionContext {
  authorized: boolean;
  reversible: boolean;
}

/** Per-conjunct promotion verdict (auditable — shows exactly which gate blocked). */
export interface PromotionDecision {
  better: boolean;
  safe: boolean;
  authorized: boolean;
  reversible: boolean;
  promote: boolean;
}

/** ADR-401 Decision 3 — the ONE governed-self-improvement predicate:
 *  `Promote = Better ∧ Safe ∧ Authorized ∧ Reversible`. Every promotion path
 *  must clear all four; no path can promote on three of four. `promotable`
 *  above is exactly its Better∧Safe core. */
export function promoteAuthorized(
  candidate: Fitness,
  champion: Fitness,
  ctx: PromotionContext,
): PromotionDecision {
  const safe = candidate.hardGatesPass === true;
  const better = candidate.separation >= champion.separation + PROMOTION_MARGIN;
  const authorized = ctx.authorized === true;
  const reversible = ctx.reversible === true;
  return { better, safe, authorized, reversible, promote: better && safe && authorized && reversible };
}

export interface GenerationRecord {
  generation: number;
  champion: EvolvableParams;
  fitness: Fitness;
  promoted: boolean;
  candidateCount: number;
}

export interface EvolutionResult {
  champion: EvolvableParams;
  fitness: Fitness;
  history: GenerationRecord[];
  promotions: number;
  /** ed25519-signed, hash-chained ledger of every generation (flywheel receipts). */
  ledgerFrames: AgentFrame[];
  ledger: PackagedTrajectory;
}

/** Run the governed evolution loop for `generations` (one flywheel turn each). */
export function evolveMesh(
  identity: PeerIdentity,
  seed: number,
  generations: number,
  population = 4,
  start: EvolvableParams = { weights: { ...DEFAULT_INDEPENDENCE_WEIGHTS }, quorumThreshold: 2.0 },
): EvolutionResult {
  const rnd = lcg(seed);
  let champion = start;
  let championFit = evaluate(champion);
  if (!championFit.hardGatesPass) throw new Error('starting params fail the hard gates');

  const history: GenerationRecord[] = [];
  const ledgerFrames: AgentFrame[] = [];
  let promotions = 0;

  for (let g = 1; g <= generations; g++) {
    let best: { params: EvolvableParams; fit: Fitness } | null = null;
    for (let i = 0; i < population; i++) {
      const cand = mutate(champion, rnd);
      const fit = evaluate(cand);
      if (!best || fit.separation > best.fit.separation) best = { params: cand, fit };
    }
    // Governed promotion through the ONE four-conjunct predicate (ADR-401 Dec 3).
    // authorized: the seeded loop stays within constitutional ceilings by
    // construction (mutate() clamps). reversible: the prior champion is always
    // retained (champion var + signed ledger) as the rollback target.
    const decision =
      best !== null
        ? promoteAuthorized(best.fit, championFit, { authorized: true, reversible: true })
        : null;
    const promoted = decision?.promote === true;
    if (promoted && best) {
      champion = best.params;
      championFit = best.fit;
      promotions += 1;
    }
    const rec: GenerationRecord = {
      generation: g,
      champion,
      fitness: championFit,
      promoted,
      candidateCount: population,
    };
    history.push(rec);
    // Signed flywheel receipt for this generation (kind 'evidence').
    ledgerFrames.push(
      signFrame(identity, {
        requestId: `mesh-evolve-${seed}`,
        agentId: 'mesh-evolver',
        step: g,
        kind: 'evidence',
        value: rec,
        confidence: 1,
        uncertainty: 0,
        dependencies: [],
        capabilityUsed: 'governed-evolution',
        evidenceHashes: [],
        cost: 0,
      }),
    );
  }

  return {
    champion,
    fitness: championFit,
    history,
    promotions,
    ledgerFrames,
    ledger: packageTrajectory(`mesh-evolve-${seed}`, ledgerFrames),
  };
}

/** Verify a ledger end-to-end: chain + every receipt signature. */
export function verifyLedger(result: EvolutionResult, publicKeyDerHex: string): boolean {
  return (
    verifyTrajectory(result.ledger, result.ledgerFrames) &&
    result.ledgerFrames.every((f) => verifyFrame(f, publicKeyDerHex))
  );
}
