# radio-moe — API / SDK Reference

Every public export of `radio-moe`, grouped by layer. Import surface is a single
entry point:

```ts
import { /* … */ } from 'radio-moe';        // → src/index.ts
```

Package: `radio-moe@0.1.0` · ESM · TypeScript · `exports: { ".": "./src/index.ts" }`.
Types are shipped from source; run under `tsx` (`node --import tsx`). This is a
reference to the *stable public surface* — signatures are grounded in
`src/index.ts` and the module doc-comments. For behavior and rationale follow the
ADR links.

---

## 1. Routing, experts, combination

```ts
import { Gate, LogitExpert, TextExpert, mixLogits, raceTextExperts, Peer, Mesh } from 'radio-moe';
```

| Export | Kind | Summary |
|---|---|---|
| `Gate` / `GateConfig` | class / type | Top-k capability router: `route(chunk, kind)` selects experts by capability cosine. |
| `Expert` | interface | Common expert contract. |
| `LogitExpert` | class | `new LogitExpert(name, capability, vocabId, vocabSize, logitsFn)` — mixable expert over a shared vocabulary. |
| `TextExpert` | class | Heterogeneous free-text expert (raced, not mixed). |
| `mixLogits(...)` | fn | Real MoE combine: `Σ wᵢ·logitsᵢ`. **Throws `IncompatibleVocabError`** across vocabularies. |
| `raceTextExperts(...)` | fn | Ensemble combine → `RaceOutcome` typed `regime: 'text-ensemble'`. |
| `MixedPosition`, `RaceOutcome` | type | Combine outputs. |
| `Peer` | class | Hosts experts (`host(expert)`), routes (`route(chunk, kind) → RouteResult`). |
| `Mesh` | class | Multi-peer coordination. |
| `RouteResult`, `Merged` | type | `{ merged, metrics }`; metrics include `routingMs`, `timeToFirstFrameMs`, `dataFrames`, `rejectedFrames`. |
| `cosine`, `softmax` | fn | Capability math (`./capability`). |

Design: [ADR-395](../../../docs/adr/ADR-395-radio-realtime-streaming-peer-expert-mesh.md).

---

## 2. Signed transport

```ts
import { PeerIdentity, Fabric, InMemorySignedTransport, TcpPeerNode, sealBatch, BatchSigner } from 'radio-moe';
```

| Export | Kind | Summary |
|---|---|---|
| `PeerIdentity` | class | `PeerIdentity.generate()`; `.sign(bytes)`, `.publicKeyDer`, `.peerId` (key fingerprint). |
| `Fabric` | class | In-process message fabric for the reference transport. |
| `InMemorySignedTransport` | class | `DataTransport` over a `Fabric` — signs every wire, verifies every inbound. |
| `DataTransport`, `SignedWire`, `WireHandler` | type | Transport contract. |
| `seal`, `verifySealed`, `wireBytes` | fn | Low-level wire sealing. |
| `TcpPeerNode`, `TcpConnection` | class | Reference **TCP** signed transport (integrity only; production wants QUIC/mTLS). |
| `sealEnvelope`, `sendEnvelope`, `verifyEnvelope`, `ReplayGuard` | fn/class | Bounded envelopes: per-`(sender,request)` sequence, replay window, 256 KiB framing. |
| `Envelope`, `EnvelopeKind`, `RejectReason`, `VerifyContext`, `TcpNodeOptions` | type | Transport types. |
| `PROTOCOL_VERSION`, `MAX_FRAME_BYTES` | const | Wire bounds. |
| `sealBatch`, `verifyBatch`, `BatchSigner`, `MAX_BATCH`, `BatchSeal` | fn/class | ADR-396 production profile: hash-chained batch signing, **1 signature per ≤64 frames**. |

Design: [ADR-396](../../../docs/adr/ADR-396-peer-expert-protocol-security-and-governed-evolution.md).

---

## 3. Streaming mixture of agents (ADR-397)

```ts
import { AgentFrame, signFrame, verifyFrame, MixtureState, signContributionInput, RelevanceScorer } from 'radio-moe';
```

### Frames
| Export | Kind | Summary |
|---|---|---|
| `AgentFrame`, `FrameKind` | type | Typed unit of expert output: `{ requestId, agentId, step, kind, value, confidence, uncertainty, dependencies, capabilityUsed, evidenceHashes, cost, signature, streamNonce? }`. |
| `signFrame(identity, unsigned)` | fn | Sign the canonical bytes → `AgentFrame`. |
| `verifyFrame(frame, publicKeyDerHex)` | fn | Verify signature over canonical, key-sorted, prototype-rejecting bytes. |
| `canonicalBytes`, `evidenceHash` | fn | Canonicalization + evidence hashing. |
| `StreamNonceGate` | class | In-frame replay binding: reject a signed frame replayed into a different stream/envelope within TTL. |

### Streaming backends
| Export | Kind | Summary |
|---|---|---|
| `CommandStreamingExpert` | class | Drive any streaming CLI as an expert. |
| `claudeCodeStreamExpert`, `codexStreamExpert` | fn | Presets for `claude -p` / `codex exec`. |
| `claudeStreamParser`, `codexStreamParser` | fn | SSE/JSONL → `PartialFrame`. |
| `endlessMixLoop(experts, prompt, requestId, onFrame)` | fn | Fold every signed frame on arrival across a pod. |
| `PartialFrame`, `RunnableExpert`, `EventParser`, `SpawnSpec`, `StreamingExpertOptions` | type | Streaming types. |

### Fusion state
| Export | Kind | Summary |
|---|---|---|
| `MixtureState` | class | `new MixtureState({ requestId, trustedSigners, coefficients?, topK? })`; `consume(frame, input) → MixtureUpdate`; `snapshot() → MixtureSnapshot` (immutable, replica-stable). |
| `signContributionInput(identity, frame, unsigned)` | fn | Detached binding signature over frame hash + dimensions. |
| `contributionBindingBytes` | fn | The bytes the binding covers. |
| `MixtureDimensions` | type | `{ quality, relevance, evidence, cost, latency, uncertainty }` (the q/r/e/c/l/u gate inputs). |
| `ContributionInput` / `UnsignedContributionInput` | type | `MixtureDimensions` + `{ claimId, relation, sourceIds, bindingSignature }`. |
| `MixtureConfig`, `MixtureCoefficients`, `MixtureContribution`, `ClaimMixture`, `Contradiction` | type | Config + snapshot shapes. `ClaimMixture` = `{ claimId, supportWeight, contradictionWeight, netWeight, confidence, contradictory, ... }`. |
| `MixtureSnapshot` | type | `{ requestId, revision, stateHash, audit, contributions, claims, contradictions, bufferedFrames, equivocatingAgents }`. |
| `MixtureUpdate` | type | `{ status: 'accepted' \| 'buffered' \| 'duplicate' \| 'rejected', snapshot, ... }`. |
| `ClaimRelation` | type | `'support' \| 'contradict'`. |
| `RelevanceScorer`, `tokenize`, `bagCosine` | class/fn | Deterministic lexical relevance for the `r` dimension. |

---

## 4. Independence & false-consensus guards

```ts
import { effectiveSupport, lineageWeightedWinner, lineageRegistry, buildCert, verifyCert, partitionEvidence } from 'radio-moe';
```

| Export | Kind | Summary |
|---|---|---|
| `pairIndependence(a, b, w?)` | fn | Pairwise independence in `[0,1]`: 0 for identical models; graded penalties for shared provider/arch/size/sources. |
| `effectiveSupport(supports, w?)` | fn | Greedy min-pairwise independent support (a graded quorum count; first supporter = 1). |
| `DEFAULT_INDEPENDENCE_WEIGHTS`, `IndependenceWeights` | const/type | Tunable penalties: `sameProvider`, `sameArch`, `sameSize`, `sourceJaccard`, `sameAccuracyBand?`. |
| `ModelLineage`, `LineageSupport` | type | `{ provider, arch, sizeClass, modelId, accuracyBand? }`; a support tagged with lineage + sourceIds. |
| `lineageWeightedWinner(snapshot, lineageOf, w?)` | fn | Re-resolve a `MixtureSnapshot`'s winning claim by lineage `effectiveSupport`. Fail-closed on unknown lineage → `LineageDecision`. |
| `lineageRegistry(record)` | fn | Build a `LineageResolver` from a static `{ agentId: ModelLineage }` registry. |
| `LineageDecision`, `LineageResolver` | type | `{ claimId \| null, effectiveSupport, netWeight }`; `(agentId) => ModelLineage \| undefined`. |
| `buildCert`, `counterSign`, `verifyCert`, `CompletionCert`, `CertPolicy` | fn/type | k-of-n counter-signing completion quorum; signers themselves must meet a minimum pairwise independence (clique-resistant). |
| `jaccard` | fn | Set overlap over sourceIds. |
| `partitionEvidence(pool, expertIds, k)`, `EvidenceRef`, `Feed`, `FeedMode` | fn/type | Decorrelated per-expert evidence feeds (never identical context to all experts). |

Design: [ADR-401](../../../docs/adr/ADR-401-perpetual-intelligence-machine.md) (capability 3 / false-consensus invariant).

---

## 5. Governed release, output ordering & failover

```ts
import { ActionGate, signActionSupport, independentSupportSet, DeterministicShadow, createTakeoverGrant } from 'radio-moe';
```

| Export | Kind | Summary |
|---|---|---|
| `ActionGate` | class | `new ActionGate({ trustedSigners, minimumQuorum, riskThreshold, admissible, gradedIndependence?, ... })`; `evaluate(action, supports, now?) → ActionDecision`. Opt-in `gradedIndependence: { minimumEffectiveSupport }` adds a strictly-tightening lineage-discounted quorum (§4) — a same-provider/arch clique that passes the binary count fails here; supports may carry a signed `lineage`, absent lineage is fail-closed. |
| `signActionSupport(identity, unsigned)` | fn | Sign an action support. |
| `actionIdentity(action, maxBytes?)` | fn | Canonical action id. |
| `supportsAreIndependent(a, b)` / `independentSupportSet(supports)` | fn | **Binary** independence (distinct modelId ∧ disjoint sourceIds) — the graded upgrade is `effectiveSupport` (§4). |
| `GovernedAction`, `ActionSupport`/`UnsignedActionSupport`, `AdmissibilityCallback`, `ActionGateOptions`, `ActionDecision`, `ActionRejection` | type | Gate shapes. `ActionDecision` = `{ execute, independentSupport, risk, mismatchedSupport, rejection? }`. |
| `DeterministicShadow` | class | Replica that retains the canonical replay checkpoint; takes over only under a signed fencing grant. |
| `createTakeoverGrant`, `TakeoverGrant`/`UnsignedTakeoverGrant` | fn/type | Signed fenced takeover. |
| `signOutputEnvelope`, `outputEnvelopeHash`, `initialStateHash`, `OutputEnvelope`, `OutputKind`, `OutputRegime`, `MixtureCheckpoint`, `UnsignedOutput`, `ShadowOptions` | fn/type | Signed, hash-chained output ordering + checkpoints. |
| `OUTPUT_PROTOCOL_VERSION`, `OutputProtocolError` | const/class | Protocol bound + error. |

---

## 6. Real backends

```ts
import { openRouterExpert, geminiExpert, harnessPodExperts } from 'radio-moe';
```

| Export | Kind | Summary |
|---|---|---|
| `openRouterExpert(agentId, identity, capability, opts)` | fn | OpenAI-compatible streaming expert. `opts.model`; key `OPENROUTER_API_KEY`. |
| `geminiExpert(agentId, identity, capability, opts?)` | fn | Vertex AI `:streamGenerateContent`. Needs `GEMINI_ACCESS_TOKEN` + `GEMINI_PROJECT`. |
| `HttpStreamingExpert`, `HttpExpertConfig`, `FetchLike` | class/type | Injectable `fetch` → the SSE parse + sign path is testable offline. `.hasCredentials()` for no-key fallback. |
| `openaiSseParser`, `geminiSseParser` | fn | SSE `data:` → `PartialFrame[]`. |
| `parseAgentModule`, `loadHarnessAgents`, `harnessPodExperts`, `roleCapability`, `HarnessAgentDef` | fn/type | Run a create-agent-harness pod (e.g. kimi-k3-harness) as mesh experts. |

Design: [ADR-399](../../../docs/adr/ADR-399-provider-backed-mesh-run-rvm-rvf.md).

---

## 7. Governed evolution (ADR-400)

```ts
import { evolveMesh, promotable, verifyLedger, CEILINGS, PROMOTION_MARGIN } from 'radio-moe';
```

| Export | Kind | Summary |
|---|---|---|
| `evolveMesh(identity, seed, generations, population?, start?)` | fn | Run the flywheel; returns `EvolutionResult` (champion, fitness, history, signed ledger). |
| `evaluateMeshParams` / `mutateMeshParams` | fn | Deterministic fitness on the frozen bench / bounded seeded mutation (clamped to ceilings). |
| `promotable(candidate, champion)` | fn | Frozen conjunctive gate: all hard gates **AND** beats champion by `≥ PROMOTION_MARGIN`. |
| `verifyLedger(result, publicKeyDerHex)` | fn | Re-derive the hash chain + every receipt signature. |
| `lcg(seed)` | fn | Deterministic PRNG (no `Math.random`) — replayable evolution. |
| `CEILINGS`, `PROMOTION_MARGIN` | const | Constitutional bounds; evolution cannot exceed them. |
| `EvolvableParams`, `Fitness`, `GenerationRecord`, `EvolutionResult` | type | Evolution shapes. `EvolvableParams` = `{ weights: IndependenceWeights, quorumThreshold }` — the ONLY evolvable surface. |

To evolve the same parameters via the external MetaHarness/Darwin toolchain, see
[METAHARNESS.md](METAHARNESS.md).

---

## 8. Control-plane substrate (re-exported)

```ts
import { RadioBus, Watcher } from 'radio-moe';   // from @metaharness/radio
```

`RadioBus`, `Watcher`, `RadioMessage`, `FoldedMention` — the in-process AgentRadio
awareness bus (metadata-only; never crosses the network).

---

## Errors you will meet

| Error | When |
|---|---|
| `IncompatibleVocabError` | `mixLogits` across experts with different `vocabId`. |
| `OutputProtocolError` | Output envelope protocol/epoch violation. |
| `MixtureUpdate.status === 'rejected'` | Untrusted signer, bad binding, stale/conflicting step, capacity/bounds. |
| `ActionDecision.rejection` | `'insufficient-independent-quorum' \| 'risk-threshold' \| 'inadmissible' \| 'action-mismatch'`. |

See the [User Guide](USER-GUIDE.md) for task-oriented walkthroughs.
