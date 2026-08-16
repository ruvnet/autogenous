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
  type RunnableExpert,
  type EventParser,
  type SpawnSpec,
  type StreamingExpertOptions,
} from './streaming-experts.js';

// Deterministic claim/evidence mixture state (ADR-397).
export {
  MixtureState,
  contributionBindingBytes,
  signContributionInput,
  type ClaimRelation,
  type MixtureDimensions,
  type ContributionInput,
  type UnsignedContributionInput,
  type MixtureCoefficients,
  type MixtureConfig,
  type MixtureContribution,
  type ClaimMixture,
  type Contradiction,
  type MixtureSnapshot,
  type MixtureUpdate,
} from './mixture.js';

// Independence-aware constitutional action release (ADR-397/396).
export {
  ActionGate,
  signActionSupport,
  actionIdentity,
  supportsAreIndependent,
  independentSupportSet,
  type GovernedAction,
  type UnsignedActionSupport,
  type ActionSupport,
  type AdmissibilityCallback,
  type ActionGateOptions,
  type ActionRejection,
  type ActionDecision,
} from './action-gate.js';

// Signed output ordering, replay checkpoints, and fenced shadow takeover.
export {
  OUTPUT_PROTOCOL_VERSION,
  OutputProtocolError,
  DeterministicShadow,
  initialStateHash,
  outputEnvelopeHash,
  signOutputEnvelope,
  createTakeoverGrant,
  type OutputKind,
  type OutputRegime,
  type MixtureCheckpoint,
  type OutputEnvelope,
  type UnsignedOutput,
  type TakeoverGrant,
  type UnsignedTakeoverGrant,
  type ShadowOptions,
} from './failover.js';

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

// Harness-pod integration: run a create-agent-harness pod (e.g. kimi-k3-harness)
// as streaming mesh experts.
export {
  parseAgentModule,
  loadHarnessAgents,
  harnessPodExperts,
  roleCapability,
  type HarnessAgentDef,
} from './harness-experts.js';

// Deterministic relevance scoring for the mixture's r_i dimension (ADR-397).
export { RelevanceScorer, tokenize, bagCosine } from './relevance.js';

// Mesh-designed modules (dogfood-1 — the mesh designed its own improvements):
export { StreamNonceGate } from './agent-frame.js';
export { partitionEvidence, type EvidenceRef, type Feed, type FeedMode } from './evidence-feeds.js';
export {
  pairIndependence,
  effectiveSupport,
  jaccard,
  buildCert,
  counterSign,
  verifyCert,
  DEFAULT_INDEPENDENCE_WEIGHTS,
  type ModelLineage,
  type LineageSupport,
  type IndependenceWeights,
  type CompletionCert,
  type CertPolicy,
} from './lineage-independence.js';

// Lineage-weighted fusion decision — re-resolve a mixture snapshot's winner by
// effectiveSupport over supporter lineage (the false-consensus guard the
// coefficient mixture's sourceId de-dup alone does not provide; ADR-401 cap 3).
export {
  lineageWeightedWinner,
  lineageRegistry,
  type LineageDecision,
  type LineageResolver,
} from './lineage-decision.js';

// External outcome verification before a durable write (ADR-401 Dec 2): the one
// measured false-consensus mitigation (task-outcome verification), gated on
// external + independent affirmation surviving adversarial refutation.
export {
  admitDurableWrite,
  signOutcomeVerdict,
  outcomeHash,
  type OutcomeVerdict,
  type UnsignedOutcomeVerdict,
  type VerdictStance,
  type OutcomeGatePolicy,
  type OutcomeGateDecision,
  type OutcomeRejection,
} from './outcome-verifier.js';

// RuField typed observation contract + fail-closed admission (ADR-402): no
// observation becomes evidence without source/location/confidence/privacy/
// calibration/expiry — unknown stays unknown.
export {
  admitObservation,
  confidenceTier,
  type Observation,
  type PrivacyClass,
  type ObservationRejection,
  type ObservationAdmission,
  type ObservationPolicy,
  type ActionTier,
  type TierThresholds,
} from './observation.js';

// Sovereign-peer disclosure boundary (ADR-401 cap 6): cooperate without pooling
// raw data — disclose signed findings + confidence + permitted evidence refs
// (digests) only, stripping raw payloads and above-ceiling evidence. Fail-closed.
export {
  discloseFinding,
  verifyDisclosure,
  assertWithinCeiling,
  evidenceDigest,
  type EvidenceItem,
  type InternalFinding,
  type DisclosurePolicy,
  type DisclosedEvidenceRef,
  type UnsignedDisclosure,
  type Disclosure,
} from './disclosure.js';

// Signed reputation ledger (ADR-401 cap 9): peers advertise capabilities and earn
// reputation ONLY from externally-verified contribution (tied to admitDurableWrite).
// The w=q·t·r/(c·l) selection weight is an UNVALIDATED hypothesis (labeled).
export {
  signCapabilityClaim,
  verifyCapabilityClaim,
  mintPerformanceRecord,
  verifyPerformanceRecord,
  reputation,
  selectionWeight,
  type CapabilityClaim,
  type UnsignedCapabilityClaim,
  type PerformanceRecord,
  type UnsignedPerformanceRecord,
  type Reputation,
  type SelectionInputs,
} from './reputation.js';

// Direct signed TCP peer transport (ADR-395/396 reference adapter — integrity
// only; production requires QUIC+mTLS or equivalent).
export {
  TcpPeerNode,
  TcpConnection,
  sealEnvelope,
  sendEnvelope,
  verifyEnvelope,
  ReplayGuard,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  type Envelope,
  type EnvelopeKind,
  type RejectReason,
  type VerifyContext,
  type TcpNodeOptions,
  frameOf,
} from './tcp-transport.js';

// TLS peer transport — the same signed-envelope logic over an encrypted node:tls
// socket, adding wire CONFIDENTIALITY on top of the TCP transport's integrity.
// PKI (key/cert/ca, mutual auth) is the deployer's, supplied via tls options.
export { TlsPeerNode, tlsSendEnvelope, TlsConnection } from './tls-transport.js';

// Cognitum Spaces adapter (ADR-402): connect the mesh to the DEPLOYED Cognitum
// Spaces service (cog_-key/Bearer authed); map a Spaces Envelope → an Observation
// so real spatial state flows through admitObservation.
export {
  CognitumSpacesClient,
  spacesEnvelopeToObservation,
  privacyOf,
  apiKeyAuth,
  bearerAuth,
  envApiKeyAuth,
  type CognitumAuth,
  type CognitumSpacesConfig,
  type CognitumSpaceTwin,
  type CognitumSpacesEnvelope,
  type SpacesBoundary,
  type SpacesListResult,
  type FetchLike as CognitumFetchLike,
} from './cognitum-spaces.js';

// ADR-396 production profile: hash-chained batch signing (1 signature per batch).
export { sealBatch, verifyBatch, BatchSigner, MAX_BATCH, type BatchSeal } from './batch-signing.js';

// Self-evolving mesh (ADR-400): governed evolution of the ADR-396-evolvable
// parameters only, flywheel receipts, frozen conjunctive promotion gate.
export {
  evolveMesh,
  evaluate as evaluateMeshParams,
  mutate as mutateMeshParams,
  promotable,
  promoteAuthorized,
  type PromotionContext,
  type PromotionDecision,
  verifyLedger,
  lcg,
  CEILINGS,
  PROMOTION_MARGIN,
  type EvolvableParams,
  type Fitness,
  type GenerationRecord,
  type EvolutionResult,
} from './mesh-evolve.js';
