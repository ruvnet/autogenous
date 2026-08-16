//! MoRA — Mixture Of Realtime Agents.
//!
//! A real-time streaming, P2P mixture-of-experts mesh:
//!   • control plane  — @metaharness/radio (AgentRadio), re-exported below
//!   • data plane     — an ed25519-signed peer transport
//!   • routing        — top-k capability gate
//!   • combination    — logit mixing (real MoE) vs text-expert racing (ensemble)
//!
//! See ADR-396 for the design and its explicit non-goals.

export * from './types.js';
export { cosine, softmax } from './capability.js';
export { Gate, type GateConfig } from './gate.js';
export { LogitExpert, TextExpert, type Expert } from './expert.js';
export {
  mixLogits,
  raceTextExperts,
  IncompatibleVocabError,
  type MixedPosition,
  type RaceOutcome,
} from './merge.js';
export {
  PeerIdentity,
  Fabric,
  InMemorySignedTransport,
  seal,
  verifySealed,
  wireBytes,
  type DataTransport,
  type SignedWire,
  type WireHandler,
} from './transport.js';
export { Peer, Mesh, type RouteResult, type Merged } from './mesh.js';

// The control-plane substrate, re-exported so consumers use one import surface.
export { RadioBus, Watcher, type RadioMessage, type FoldedMention } from '@metaharness/radio';

// Streaming mixture of agents (ADR-397): AgentFrame contract + real backends.
export {
  type AgentFrame,
  type FrameKind,
  canonicalBytes,
  signFrame,
  verifyFrame,
  evidenceHash,
} from './agent-frame.js';
export {
  CommandStreamingExpert,
  claudeCodeStreamExpert,
  codexStreamExpert,
  claudeStreamParser,
  codexStreamParser,
  endlessMixLoop,
  type PartialFrame,
  type EventParser,
  type SpawnSpec,
  type StreamingExpertOptions,
} from './streaming-experts.js';

// HTTP streaming providers (ADR-399): run the mesh against OpenRouter / Gemini.
export {
  HttpStreamingExpert,
  openRouterExpert,
  geminiExpert,
  openaiSseParser,
  geminiSseParser,
  type HttpExpertConfig,
  type FetchLike,
} from './http-experts.js';
