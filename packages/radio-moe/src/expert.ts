//! Experts — the "realtime agents" of the mixture.
//!
//! An expert is one regime only: a `logit` expert shares a tokenizer and streams
//! per-position logit vectors (mixable); a `text` expert streams free text
//! (raceable, not mixable). Both are deterministic given a chunk so runs replay.
//!
//! The bodies here are reference stubs — a real expert wraps a local model or a
//! remote endpoint. The mesh only depends on the `Expert` interface.

import type { CapabilityVector, Chunk, ExpertFrame, LogitFrame, TextFrame } from './types.js';

export interface Expert {
  readonly expertId: string;
  readonly kind: 'logit' | 'text';
  readonly capability: CapabilityVector;
  /** Deterministic stream of frames for `chunk`. `peerId` stamps provenance. */
  run(chunk: Chunk, peerId: string): ExpertFrame[];
}

/** A logit expert over a shared vocabulary. `bias(chunk, position)` returns the
 *  raw logit vector this expert would emit; the mesh mixes them Σ wᵢ·logitsᵢ. */
export class LogitExpert implements Expert {
  readonly kind = 'logit' as const;
  constructor(
    readonly expertId: string,
    readonly capability: CapabilityVector,
    readonly vocabId: string,
    readonly vocabSize: number,
    private readonly bias: (chunk: Chunk, position: number) => number[],
    private readonly positions = 1,
  ) {}

  run(chunk: Chunk, peerId: string): LogitFrame[] {
    const chunkId = `${chunk.streamId}#${chunk.seq}`;
    const frames: LogitFrame[] = [];
    for (let p = 0; p < this.positions; p++) {
      const logits = this.bias(chunk, p);
      if (logits.length !== this.vocabSize) {
        throw new Error(`${this.expertId}: bias length ${logits.length} != vocabSize ${this.vocabSize}`);
      }
      frames.push({
        kind: 'logit',
        chunkId,
        expertId: this.expertId,
        peerId,
        position: p,
        vocabId: this.vocabId,
        logits,
        final: p === this.positions - 1,
      });
    }
    return frames;
  }
}

/** A text expert. `answer(chunk)` returns its full text; the mesh streams it as
 *  tokens (whitespace-split) then a final frame, and RACES it against peers. */
export class TextExpert implements Expert {
  readonly kind = 'text' as const;
  constructor(
    readonly expertId: string,
    readonly capability: CapabilityVector,
    private readonly answer: (chunk: Chunk) => string,
  ) {}

  run(chunk: Chunk, peerId: string): TextFrame[] {
    const chunkId = `${chunk.streamId}#${chunk.seq}`;
    const text = this.answer(chunk);
    const tokens = text.length ? text.split(/(\s+)/).filter((t) => t.length) : [];
    const frames: TextFrame[] = [];
    let acc = '';
    tokens.forEach((tok, i) => {
      acc += acc && !/^\s/.test(tok) ? ' ' + tok : tok;
      frames.push({
        kind: 'text',
        chunkId,
        expertId: this.expertId,
        peerId,
        seq: i,
        tokens: tok,
        final: false,
      });
    });
    frames.push({
      kind: 'text',
      chunkId,
      expertId: this.expertId,
      peerId,
      seq: tokens.length,
      tokens: text,
      final: true,
    });
    return frames;
  }
}
