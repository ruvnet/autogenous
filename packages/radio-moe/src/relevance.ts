//! Deterministic relevance scoring for the level-2 mixture (ADR-397 `r_i`).
//!
//! Replaces the confidence stand-in with a real, content-derived signal:
//!
//!   r_i(frame) = topicality · novelty
//!
//!   topicality — term-frequency cosine between the frame's text and the
//!                request context (prompt + accepted trajectory so far);
//!   novelty    — 1 − max similarity against contributions ALREADY folded, so a
//!                near-verbatim echo of another agent scores low even when it is
//!                perfectly on-topic (the lexical cousin of ADR-398's
//!                false-consensus rule: repetition is not new information).
//!
//! Pure and deterministic — no model call, no network — so mixture runs replay.
//! This is the lexical floor; a semantic-embedding scorer can replace it behind
//! the same interface without touching the mixture.

import type { AgentFrame } from './agent-frame.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
  'to', 'was', 'we', 'were', 'while', 'with', 'you', 'your',
]);

/** Lowercased, stopword-filtered term bag. */
export function tokenize(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    bag.set(raw, (bag.get(raw) ?? 0) + 1);
  }
  return bag;
}

/** Cosine similarity between two term bags, in [0, 1]. */
export function bagCosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, wa] of small) {
    const wb = large.get(term);
    if (wb !== undefined) dot += wa * wb;
  }
  if (dot === 0) return 0;
  const norm = (m: Map<string, number>): number =>
    Math.sqrt([...m.values()].reduce((s, w) => s + w * w, 0));
  return dot / (norm(a) * norm(b));
}

function frameText(frame: AgentFrame): string {
  return typeof frame.value === 'string' ? frame.value : JSON.stringify(frame.value ?? '');
}

/**
 * Scores frames for one request. `fold` text into the context as contributions
 * are accepted so topicality tracks the LIVE trajectory, not just the prompt.
 */
export class RelevanceScorer {
  private context: Map<string, number>;
  /** Per-agent accumulated text (streamed deltas concatenate). */
  private readonly byAgent = new Map<string, string>();

  constructor(prompt: string) {
    this.context = tokenize(prompt);
  }

  /**
   * Relevance of `frame` in [0, 1]: topicality vs the current context, damped
   * by similarity to what OTHER agents have already contributed (echo penalty).
   * Streamed deltas are scored on the agent's accumulated text so short chunks
   * are not punished for being short.
   */
  score(frame: AgentFrame): number {
    const text = frameText(frame);
    const accumulated = (this.byAgent.get(frame.agentId) ?? '') + text;
    this.byAgent.set(frame.agentId, accumulated);

    const bag = tokenize(accumulated);
    if (bag.size === 0) return 0;
    const topicality = bagCosine(bag, this.context);

    let maxEcho = 0;
    for (const [agent, otherText] of this.byAgent) {
      if (agent === frame.agentId) continue;
      const sim = bagCosine(bag, tokenize(otherText));
      if (sim > maxEcho) maxEcho = sim;
    }
    const novelty = 1 - maxEcho;
    return topicality * (0.25 + 0.75 * novelty); // echoes are damped, not zeroed
  }

  /** Fold accepted content into the live context (call on accepted claims). */
  fold(text: string): void {
    const merged = new Map(this.context);
    for (const [term, w] of tokenize(text)) merged.set(term, (merged.get(term) ?? 0) + w);
    this.context = merged;
  }
}
