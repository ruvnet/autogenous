//! Combination — the two regimes kept mathematically distinct (ADR-396).
//!
//!   • `mixLogits` — the REAL mixture-of-experts combine. Experts that share a
//!     tokenizer stream per-position logit vectors; the mixed distribution is
//!     Σ wᵢ·logitsᵢ (weights renormalized over the frames actually present at
//!     this position). Refuses to mix across differing vocab lengths — you
//!     cannot add logits from different token spaces.
//!
//!   • `raceTextExperts` — heterogeneous text experts produce free text. There
//!     is NO shared coordinate system, so there is no mathematical mixture: the
//!     gate weight selects/ranks. This is an ENSEMBLE (a race), and every return
//!     value says so. Calling it "MoE" would be a category error.

import type { LogitFrame, RoutedExpert, TextFrame } from './types.js';

export class IncompatibleVocabError extends Error {
  constructor(lengths: number[]) {
    super(`cannot mix logits across different vocab sizes: ${lengths.join(', ')}`);
    this.name = 'IncompatibleVocabError';
  }
}

/** The mathematically-mixed distribution at one output position. */
export interface MixedPosition {
  position: number;
  /** Σ wᵢ·logitsᵢ over the contributing experts, renormalized. */
  logits: number[];
  /** argmax token id of the mixed distribution. */
  argmax: number;
  contributors: { expertId: string; weight: number }[];
}

/**
 * TRUE MoE combine for one position. `frames` are the logit frames received for
 * a single (chunk, position); `weights` maps expertId → gate weight. Weights are
 * renormalized over exactly the frames present (a straggler that hasn't arrived
 * doesn't get counted). Throws if the frames disagree on vocab size.
 */
export function mixLogits(
  frames: LogitFrame[],
  weights: Map<string, number>,
): MixedPosition {
  if (frames.length === 0) throw new Error('mixLogits: no frames');
  const size = frames[0]!.logits.length;
  const lengths = frames.map((f) => f.logits.length);
  if (lengths.some((l) => l !== size)) throw new IncompatibleVocabError(lengths);

  const present = frames.map((f) => weights.get(f.expertId) ?? 0);
  const wsum = present.reduce((a, b) => a + b, 0) || 1;

  const mixed = new Array<number>(size).fill(0);
  const contributors: { expertId: string; weight: number }[] = [];
  frames.forEach((f, i) => {
    const w = present[i]! / wsum;
    contributors.push({ expertId: f.expertId, weight: w });
    for (let k = 0; k < size; k++) mixed[k]! += w * f.logits[k]!;
  });

  let argmax = 0;
  for (let k = 1; k < size; k++) if (mixed[k]! > mixed[argmax]!) argmax = k;

  return { position: frames[0]!.position, logits: mixed, argmax, contributors };
}

/** The outcome of a text-expert race — explicitly an ensemble, not a mixture. */
export interface RaceOutcome {
  regime: 'text-ensemble';
  /** The winning expert's full text (highest gate weight; ties broken by earliest final). */
  winner: { expertId: string; peerId: string; weight: number; text: string };
  /** The full ranked field, for auditability and re-ranking. */
  ranked: { expertId: string; peerId: string; weight: number; text: string }[];
}

/**
 * Rank heterogeneous text experts by gate weight and return the winner plus the
 * full field. Does NOT concatenate or average text (there is no shared space to
 * average in). `finals` is the assembled final text per expert, in arrival order
 * (arrival order breaks weight ties — the faster expert wins).
 */
export function raceTextExperts(
  routed: RoutedExpert[],
  finals: TextFrame[],
): RaceOutcome {
  const weightOf = new Map(routed.map((r) => [r.expertId, r.weight]));
  const ranked = finals
    .map((f, arrival) => ({
      expertId: f.expertId,
      peerId: f.peerId,
      weight: weightOf.get(f.expertId) ?? 0,
      text: f.tokens,
      arrival,
    }))
    .sort((a, b) => b.weight - a.weight || a.arrival - b.arrival)
    .map(({ arrival: _arrival, ...rest }) => rest);

  const winner = ranked[0] ?? { expertId: '', peerId: '', weight: 0, text: '' };
  return { regime: 'text-ensemble', winner, ranked };
}
