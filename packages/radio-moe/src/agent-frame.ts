//! The AgentFrame contract (ADR-397) — the canonical incremental representation
//! every streaming agent emits instead of unrestricted prose.
//!
//! The premise the architecture rejects: mixing agent *prose* is not a mixture.
//! A true mixture requires every agent to emit a compatible, scoreable
//! incremental unit while execution is still underway. That unit is `AgentFrame`.
//!
//! Frames are signed over a **canonical** serialization (recursively key-sorted,
//! prototype-pollution-rejecting) so a receiver authenticates a frame before it
//! is folded into the shared mixture state.

import { createHash, sign as edSign, verify as edVerify } from 'node:crypto';
import type { PeerIdentity } from './transport.js';

/** What an agent is contributing at this step. */
export type FrameKind = 'claim' | 'evidence' | 'plan' | 'action' | 'logits';

/** One incremental contribution to a live reasoning trajectory (ADR-397). */
export interface AgentFrame {
  requestId: string;
  agentId: string;
  /** Monotonic per-(agent,request) step index. */
  step: number;
  kind: FrameKind;
  /** The payload — text delta, structured claim, plan update, action proposal,
   *  or a bounded logit vector. Interpreted per `kind`. */
  value: unknown;
  /** 0..1 the agent's stated confidence in `value`. */
  confidence: number;
  /** 0..1 the agent's stated uncertainty (calibration; not 1-confidence). */
  uncertainty: number;
  /** Frame ids this contribution depends on (for alignment, not ordering). */
  dependencies: string[];
  capabilityUsed: string;
  /** Content hashes of supporting evidence — shareable without the raw data. */
  evidenceHashes: string[];
  /** Metered cost of producing this frame. */
  cost: number;
  /** In-frame replay binding (mesh-designed, dogfood-1 architect frame): the
   *  RECEIVER-issued per-stream nonce, echoed by the producer inside the signed
   *  frame. A frame captured on stream A cannot verify on stream B — the
   *  attacker cannot produce a signature covering B's nonce. Optional for
   *  backward compatibility; when present it is under the signature. */
  streamNonce?: string;
  /** ed25519 signature over the canonical frame-without-signature (hex). */
  signature: string;
}

/** Consumption-point gate for in-frame replay binding: accepts a frame only if
 *  it echoes the nonce THIS gate issued and its (agentId, step) is unseen. */
export class StreamNonceGate {
  private readonly seen = new Set<string>();
  constructor(readonly nonce: string) {}

  accept(frame: AgentFrame): boolean {
    if (frame.streamNonce !== this.nonce) return false;
    const key = `${frame.agentId}#${frame.step}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/** Recursively key-sorted JSON, rejecting prototype-pollution keys, as bytes.
 *  Two peers that build the same logical frame produce identical signing bytes. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalString(value));
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function canonicalString(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalString).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (FORBIDDEN.has(k)) throw new Error(`forbidden key in canonical payload: ${k}`);
    parts.push(`${JSON.stringify(k)}:${canonicalString(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/** Bytes the signature covers — the frame with an empty signature field. */
function frameSigningBytes(frame: AgentFrame): Buffer {
  return canonicalBytes({ ...frame, signature: '' });
}

/** Sign a frame in place-ish: returns a copy with `signature` set. */
export function signFrame(identity: PeerIdentity, frame: Omit<AgentFrame, 'signature'>): AgentFrame {
  const unsigned: AgentFrame = { ...frame, signature: '' };
  const sig = identity.sign(frameSigningBytes(unsigned));
  return { ...unsigned, signature: sig };
}

/** Verify a frame's signature against a signer's DER SPKI public key (hex). */
export function verifyFrame(frame: AgentFrame, publicKeyDerHex: string): boolean {
  try {
    const der = Buffer.from(publicKeyDerHex, 'hex');
    return edVerify(
      null,
      frameSigningBytes(frame),
      { key: der, format: 'der', type: 'spki' },
      Buffer.from(frame.signature, 'hex'),
    );
  } catch {
    return false;
  }
}

/** Content hash of any evidence blob — the shareable reference in `evidenceHashes`. */
export function evidenceHash(blob: string): string {
  return createHash('sha256').update(blob).digest('hex');
}

// A local re-export so adapters can sign without importing node:crypto directly.
export { edSign };
