//! Core types for MoRA — Mixture Of Realtime Agents.
//!
//! Two planes, deliberately separate (see ADR-396):
//!   • CONTROL plane — @metaharness/radio (AgentRadio): adverts, routing
//!     decisions, and passive teammate-discovery folds. In-process, deterministic.
//!   • DATA plane — a direct, ed25519-SIGNED peer transport carrying streamed
//!     expert frames. This is the only thing that crosses the network.
//!
//! And two distinct combination regimes, never conflated:
//!   • LOGIT mixing — the *real* mathematical MoE: experts sharing a tokenizer
//!     stream per-position logit vectors; the mixer computes Σ wᵢ·logitsᵢ.
//!   • TEXT racing — heterogeneous experts stream free text; the gate weights
//!     rank/select. This is an ENSEMBLE, not mathematical MoE, and is labelled
//!     as such everywhere.

/** A dense competence embedding for an expert (unit-scale, any dimension). */
export type CapabilityVector = number[];

/** One unit of the input stream to be routed. `features` is the routing embedding
 *  (same space as capability vectors). */
export interface Chunk {
  streamId: string;
  seq: number;
  features: number[];
  /** Optional human-readable payload (prompt fragment, task text). */
  text?: string;
}

/** What an expert can combine as. A given expert is one or the other, never both. */
export type ExpertKind = 'logit' | 'text';

/** An expert's self-advertisement, gossiped on the control plane. */
export interface ExpertAdvert {
  peerId: string;
  expertId: string;
  kind: ExpertKind;
  capability: CapabilityVector;
  /** For 'logit' experts only: an id identifying the SHARED tokenizer/vocab.
   *  Logit mixing is refused across differing vocabIds (incompatible spaces). */
  vocabId?: string;
  /** For 'logit' experts only: the vocabulary size = logit vector length. */
  vocabSize?: number;
  /** Optional 0..1 load signal; higher = busier. Used as a soft tie-break. */
  loadHint?: number;
}

/** One routed selection: an expert and its normalized mixing weight. */
export interface RoutedExpert {
  expertId: string;
  peerId: string;
  score: number;
  weight: number;
}

/** The gate's decision for a single chunk. */
export interface GateDecision {
  chunkId: string;
  kind: ExpertKind;
  routed: RoutedExpert[];
}

/** A streamed logit frame from a 'logit' expert (real-MoE data plane). */
export interface LogitFrame {
  kind: 'logit';
  chunkId: string;
  expertId: string;
  peerId: string;
  /** Output position within the chunk's generation. */
  position: number;
  vocabId: string;
  /** Length MUST equal the advert's vocabSize; validated on receipt. */
  logits: number[];
  final: boolean;
}

/** A streamed text frame from a 'text' expert (ensemble/racing data plane). */
export interface TextFrame {
  kind: 'text';
  chunkId: string;
  expertId: string;
  peerId: string;
  seq: number;
  tokens: string;
  final: boolean;
}

export type ExpertFrame = LogitFrame | TextFrame;

/** Control: an expert advertises itself to the mesh at join (the handshake that
 *  the local AgentRadio awareness plane never crosses the network for). */
export interface AdvertWire {
  kind: 'advert';
  peerId: string;
  advert: ExpertAdvert;
}

/** Control: the router asks the owning peer to run `expertId` on `chunk`. */
export interface DispatchWire {
  kind: 'dispatch';
  peerId: string;
  chunkId: string;
  chunk: Chunk;
  expertId: string;
  expectKind: ExpertKind;
}

/** Everything that crosses the signed transport. All carry `kind` + `peerId`. */
export type Wire = AdvertWire | DispatchWire | LogitFrame | TextFrame;

/** Per-route measurements (the whole point of "realtime"). */
export interface RouteMetrics {
  /** Time to compute the gate decision. */
  routingMs: number;
  /** Time from dispatch to the first expert frame arriving. */
  timeToFirstFrameMs: number;
  /** Wall time until the merged result was final. */
  totalMs: number;
  /** AgentRadio messages spent coordinating this route (comms cost). */
  controlMessages: number;
  /** Data-plane frames received. */
  dataFrames: number;
  /** Frames dropped because their signature did not verify. */
  rejectedFrames: number;
}
