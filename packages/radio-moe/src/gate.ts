//! The gate: top-k expert routing by capability similarity.
//!
//! The gate never mixes `logit` and `text` experts in one decision — the two
//! combination regimes are incompatible (ADR-396). A route is asked for a
//! specific `kind`; only experts of that kind are considered.

import { cosine, softmax } from './capability.js';
import type { Chunk, ExpertAdvert, ExpertKind, GateDecision, RoutedExpert } from './types.js';

export interface GateConfig {
  /** Number of experts to activate per chunk. */
  topK: number;
  /** Softmax temperature over the top-k scores (> 0). Lower = peakier weights. */
  tau: number;
}

const DEFAULT_CONFIG: GateConfig = { topK: 2, tau: 0.5 };

export class Gate {
  private readonly adverts = new Map<string, ExpertAdvert>();
  private readonly cfg: GateConfig;

  constructor(cfg: Partial<GateConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** Register or refresh an expert advert (idempotent on expertId). */
  register(advert: ExpertAdvert): void {
    this.adverts.set(advert.expertId, advert);
  }

  remove(expertId: string): void {
    this.adverts.delete(expertId);
  }

  known(): ExpertAdvert[] {
    return [...this.adverts.values()];
  }

  /**
   * Route one chunk to the top-k experts of `kind`, weighting them by a
   * temperature-softmax over cosine capability scores (load nudges ties down).
   * For `logit` routing, only experts sharing the FIRST-ranked expert's vocabId
   * are eligible — you cannot mathematically mix logits across tokenizers.
   */
  route(chunk: Chunk, kind: ExpertKind): GateDecision {
    const chunkId = `${chunk.streamId}#${chunk.seq}`;
    let pool = this.known().filter((a) => a.kind === kind);

    const scored = pool
      .map((a) => ({
        a,
        score: cosine(chunk.features, a.capability) - 0.05 * (a.loadHint ?? 0),
      }))
      .sort((x, y) => y.score - x.score);

    if (kind === 'logit' && scored.length > 0) {
      const vocab = scored[0]!.a.vocabId;
      for (let i = scored.length - 1; i >= 0; i--) {
        if (scored[i]!.a.vocabId !== vocab) scored.splice(i, 1);
      }
    }

    const top = scored.slice(0, Math.max(1, this.cfg.topK));
    const weights = softmax(
      top.map((t) => t.score),
      this.cfg.tau,
    );
    const routed: RoutedExpert[] = top.map((t, i) => ({
      expertId: t.a.expertId,
      peerId: t.a.peerId,
      score: t.score,
      weight: weights[i]!,
    }));

    return { chunkId, kind, routed };
  }
}
