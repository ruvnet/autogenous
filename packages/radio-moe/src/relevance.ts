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

/** A request-local bag with a cached norm. No response history is retained. */
class TermBag {
  readonly terms = new Map<string, number>();
  private squareSum = 0;
  private norm = 0;

  adjust(term: string, delta: number): void {
    if (term.length < 3 || STOPWORDS.has(term)) return;
    const before = this.terms.get(term) ?? 0;
    const after = before + delta;
    if (after === 0) this.terms.delete(term);
    else this.terms.set(term, after);
    this.squareSum += after * after - before * before;
    this.norm = Math.sqrt(this.squareSum);
  }

  /** A fold is a separate token sequence, just as in the original scorer. */
  fold(text: string): void {
    for (const [term, count] of tokenize(text)) this.adjust(term, count);
  }

  cosine(other: TermBag): number {
    if (this.norm === 0 || other.norm === 0) return 0;
    const [small, large] = this.terms.size <= other.terms.size
      ? [this.terms, other.terms] : [other.terms, this.terms];
    let dot = 0;
    for (const [term, count] of small) dot += count * (large.get(term) ?? 0);
    return dot / (this.norm * other.norm);
  }
}

/** Only the unfinished ASCII token can change when a delta arrives. */
class StreamingTermBag extends TermBag {
  private tail = '';

  append(text: string): void {
    if (text.length === 0) return;
    // The old tail was provisionally counted so every prefix can be scored.
    this.adjust(this.tail, -1);
    const parts = (this.tail + text.toLowerCase()).split(/[^a-z0-9]+/);
    for (const term of parts) this.adjust(term, 1);
    this.tail = parts[parts.length - 1]!;
  }
}

/**
 * Scores frames for one request. `fold` text into the context as contributions
 * are accepted so topicality tracks the LIVE trajectory, not just the prompt.
 * Counts are incremental, including words split across arbitrary deltas. Each
 * peer keeps a term bag and unfinished token instead of its entire response.
 * Lifetime and input budgets remain the request owner's responsibility.
 */
export class RelevanceScorer {
  private readonly context = new TermBag();
  private readonly byAgent = new Map<string, StreamingTermBag>();

  constructor(prompt: string) {
    this.context.fold(prompt);
  }

  /** Lexical topicality with the existing other-agent echo penalty. */
  score(frame: AgentFrame): number {
    const text = frameText(frame);
    let bag = this.byAgent.get(frame.agentId);
    if (!bag) {
      bag = new StreamingTermBag();
      this.byAgent.set(frame.agentId, bag);
    }
    // Match the original string concatenation for non-JSON values too.
    bag.append(String(text));
    if (bag.terms.size === 0) return 0;
    const topicality = bag.cosine(this.context);
    let maxEcho = 0;
    for (const [agent, other] of this.byAgent) {
      if (agent === frame.agentId) continue;
      const sim = bag.cosine(other);
      if (sim > maxEcho) maxEcho = sim;
    }
    return topicality * (0.25 + 0.75 * (1 - maxEcho));
  }

  /** Fold accepted content into the live context (call on accepted claims). */
  fold(text: string): void {
    this.context.fold(text);
  }
}
