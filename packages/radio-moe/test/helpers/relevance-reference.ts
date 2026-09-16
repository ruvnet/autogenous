// Frozen pre-optimization algorithm from commit 7bf327a9754ce798364dbee8b2825af42a421fd4.
// Test and benchmark oracle; never used by the production scorer.
import { tokenize, bagCosine } from '../../src/relevance.js';
import type { AgentFrame } from '../../src/agent-frame.js';

function frameText(frame: AgentFrame): string {
  return typeof frame.value === 'string' ? frame.value : JSON.stringify(frame.value ?? '');
}

/**
 * Scores frames for one request. `fold` text into the context as contributions
 * are accepted so topicality tracks the LIVE trajectory, not just the prompt.
 */
export class ReferenceRelevanceScorer {
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
