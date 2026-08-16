//! Hash-chained batch signing — ADR-396's production profile:
//!
//! > "A production profile may sign bounded hash-chained batches of deltas,
//! >  provided the receiver authenticates the batch before exposing output and
//! >  preserves per-request ordering."
//!
//! Instead of one ed25519 signature per frame (integrity-first reference
//! profile, ~0.06 ms/verify), the sender chains frame hashes
//! (`link_i = sha256(link_{i-1} ‖ sha256(canonical(frame_i)))`) and signs ONLY
//! the batch root. The receiver recomputes the chain (hash-speed) and verifies
//! ONE signature per batch — amortizing the expensive ed25519 operation over
//! `size` frames while preserving order (the chain breaks on any reorder,
//! tamper, drop, or insertion). Batches are BOUNDED (`MAX_BATCH`) so a slow
//! stream cannot defer authentication indefinitely; flush on end-of-stream.

import { createHash } from 'node:crypto';
import { verify as edVerify } from 'node:crypto';
import { canonicalBytes, type AgentFrame } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';

export const MAX_BATCH = 64;

/** A signed batch: order-preserving hash chain over `count` frames + one signature. */
export interface BatchSeal {
  requestId: string;
  agentId: string;
  /** Index of the first frame in this batch within the stream. */
  startIndex: number;
  count: number;
  /** chain root: fold of sha256(link ‖ frameHash) over the batch, from ''. */
  root: string;
  /** ed25519 over `requestId|agentId|startIndex|count|root` by the sender. */
  signature: string;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function chainRoot(frames: readonly AgentFrame[]): string {
  let link = '';
  for (const f of frames) link = sha256(link + sha256(canonicalBytes(f)));
  return link;
}

function sealBytes(s: Omit<BatchSeal, 'signature'>): Buffer {
  return Buffer.from(`${s.requestId}|${s.agentId}|${s.startIndex}|${s.count}|${s.root}`);
}

/** Sign one bounded batch of ordered frames. Throws when the batch exceeds MAX_BATCH. */
export function sealBatch(
  identity: PeerIdentity,
  requestId: string,
  agentId: string,
  startIndex: number,
  frames: readonly AgentFrame[],
): BatchSeal {
  if (frames.length === 0 || frames.length > MAX_BATCH) {
    throw new Error(`batch size ${frames.length} outside 1..${MAX_BATCH}`);
  }
  const unsigned = { requestId, agentId, startIndex, count: frames.length, root: chainRoot(frames) };
  return { ...unsigned, signature: identity.sign(sealBytes(unsigned)) };
}

/** Verify one batch: recompute the chain (hash-speed) + ONE ed25519 verify. */
export function verifyBatch(
  seal: BatchSeal,
  frames: readonly AgentFrame[],
  publicKeyDerHex: string,
): boolean {
  if (frames.length !== seal.count) return false;
  if (chainRoot(frames) !== seal.root) return false;
  try {
    return edVerify(
      null,
      sealBytes(seal),
      { key: Buffer.from(publicKeyDerHex, 'hex'), format: 'der', type: 'spki' },
      Buffer.from(seal.signature, 'hex'),
    );
  } catch {
    return false;
  }
}

/** Streaming accumulator: collect frames, emit a seal every MAX_BATCH or on flush. */
export class BatchSigner {
  private pending: AgentFrame[] = [];
  private nextIndex = 0;

  constructor(
    private readonly identity: PeerIdentity,
    private readonly requestId: string,
    private readonly agentId: string,
    private readonly size = MAX_BATCH,
  ) {
    if (size < 1 || size > MAX_BATCH) throw new Error(`size outside 1..${MAX_BATCH}`);
  }

  /** Add a frame; returns a seal when the bounded batch fills, else null. */
  push(frame: AgentFrame): BatchSeal | null {
    this.pending.push(frame);
    return this.pending.length >= this.size ? this.flush() : null;
  }

  /** Seal whatever is pending (end-of-stream). Null when nothing is pending. */
  flush(): BatchSeal | null {
    if (this.pending.length === 0) return null;
    const seal = sealBatch(this.identity, this.requestId, this.agentId, this.nextIndex, this.pending);
    this.nextIndex += this.pending.length;
    this.pending = [];
    return seal;
  }
}
