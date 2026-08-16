# radio-moe — governed streaming peer-expert mesh + streaming mixture of agents

**A real-time, peer-to-peer mixture-of-experts mesh.** Heterogeneous experts live
on different peers, advertise what they're good at, are routed per input chunk by a
top-k gate, and their **streamed** output is combined in the *correct* regime —
mathematically mixed when they share a tokenizer, raced as an ensemble when they
don't. Above the raw stream sits a governed decision layer: signed typed frames,
continuous claim/evidence fusion, independence-weighted quorum, and a
constitution-pinned action gate — so the mesh can keep operating and improving
while individual experts, models, and machines come and go.

> Internal name **MoRA** (Mixture Of Realtime Agents). Package name `radio-moe`.
> Design of record: [ADR-395](../../docs/adr/ADR-395-radio-realtime-streaming-peer-expert-mesh.md)
> → [ADR-402](../../docs/adr/ADR-402-ruview-cognitum-spaces-spatial-intelligence.md).

Two grounded primitives, kept strictly separate:

| Plane | Library | Role |
|---|---|---|
| **Control** | [`@metaharness/radio`](https://www.npmjs.com/package/@metaharness/radio) (AgentRadio) | In-process awareness bus — routing decisions + passive teammate-discovery folds at step boundaries. Never crosses the network. |
| **Data** | native `node:crypto` ed25519 | Direct, **signed** peer transport (in-memory fabric + reference TCP) carrying adverts, dispatch requests, and streamed expert frames. Every inbound frame is verified. |

## The one distinction that matters

```
logit experts  (shared tokenizer)   →  mixLogits        →  Σ wᵢ·logitsᵢ    ← real MoE
text experts   (heterogeneous)       →  raceTextExperts  →  weighted winner ← an ENSEMBLE
```

True mixture-of-experts requires a shared coordinate system: per-token logits over
one vocabulary. Racing free-text experts and picking a winner is an **ensemble, not
a mixture**. radio-moe refuses to conflate them: `mixLogits` throws across
incompatible vocabularies, and the race result is literally typed
`regime: 'text-ensemble'`.

## Quick start

```bash
npm install
npm test              # 134 offline, deterministic tests
npm run demo          # a 3-peer local mesh — both regimes
npm run bench:fusion  # does the fused mixture beat the strongest single expert?
```

```ts
import { Fabric, InMemorySignedTransport, PeerIdentity, Peer, LogitExpert } from 'radio-moe';

const fabric = new Fabric();
const mk = () => { const id = PeerIdentity.generate(); return new Peer(id, new InMemorySignedTransport(id, fabric)); };
const [a, b] = [mk(), mk()];

a.host(new LogitExpert('grammar', [1, 0, 0, 0], 'vocab', 4, () => [3, 0, 0, 0]));
b.host(new LogitExpert('facts',   [0, 1, 0, 0], 'vocab', 4, () => [0, 3, 0, 0]));

const res = a.route({ streamId: 's', seq: 0, features: [0.9, 0.6, 0, 0] }, 'logit');
console.log(res.merged);   // { kind: 'logit', positions: [...], tokens: [...] }
console.log(res.metrics);  // routingMs, timeToFirstFrameMs, dataFrames, rejectedFrames, ...
```

New here? Read the **[User Guide](docs/USER-GUIDE.md)** (task-oriented, five walkthroughs)
and the **[API / SDK Reference](docs/API.md)** (every public export, grouped by layer).

## What's in the box

| Layer | Modules | What it does |
|---|---|---|
| **Routing + combine** | `Gate`, `LogitExpert`/`TextExpert`, `mixLogits`/`raceTextExperts`, `Peer`/`Mesh` | Top-k capability routing; regime-correct combination. |
| **Signed transport** | `PeerIdentity`, `InMemorySignedTransport`, `TcpPeerNode`, `TlsPeerNode`, `sealBatch`/`BatchSigner` | ed25519-signed frames; reference TCP peer (integrity) + a TLS peer (integrity **+ confidentiality**, deployer-supplied PKI); hash-chained batch signing (1 sig / ≤64 frames). |
| **Streaming mixture (ADR-397)** | `AgentFrame`, `signFrame`/`verifyFrame`, `MixtureState`, `RelevanceScorer` | Typed signed claim/evidence frames folded continuously with q/r/e/c/l/u weighting, provenance, contradiction tracking, replica-stable state hashes. |
| **Governed release** | `ActionGate`, `independentSupportSet`, `DeterministicShadow`, `createTakeoverGrant` | Actions release only from signed, admitted, independently-sourced support under a frozen policy; signed output ordering; fenced shadow takeover. |
| **Independence / false-consensus** | `effectiveSupport`, `lineageWeightedWinner`, `admitDurableWrite`, `buildCert`/`verifyCert`, `partitionEvidence` | Lineage-graded independence (provider/arch/size), lineage-weighted fusion decision, external+adversarial outcome verification before durable writes, k-of-n counter-signing quorum, decorrelated evidence feeds. |
| **Spatial & cross-org (ADR-402 / cap 6)** | `admitObservation`/`confidenceTier`, `discloseFinding`/`verifyDisclosure` | Fail-closed RuField observation admission (no fact without calibration/expiry); sovereign-peer signed disclosure carrying only permitted evidence refs, never raw data. |
| **Real backends** | `openRouterExpert`, `geminiExpert`, `CommandStreamingExpert` (`claude`/`codex`), `harnessPodExperts` | Run the mesh against OpenRouter / Gemini / local `claude -p` / `codex exec` / create-agent-harness pods. |
| **Governed evolution (ADR-400/401)** | `evolveMesh`, `promotable`, `promoteAuthorized`, `verifyLedger`, `CEILINGS` | Flywheel over the *evolvable* params only, inside frozen ceilings, ed25519-signed receipts; promotion gated by the one predicate `Better ∧ Safe ∧ Authorized ∧ Reversible`. |
| **Reputation market (ADR-401 cap 9)** | `signCapabilityClaim`, `mintPerformanceRecord`, `reputation`, `selectionWeight` | Peers advertise capabilities and earn reputation only from externally-verified contribution (tied to `admitDurableWrite`); the `w=q·t·r/(c·l)` selection weight is a labeled *unvalidated* hypothesis. |
| **Cognitum integration (ADR-402/093)** | `CognitumSpacesClient`, `spacesEnvelopeToObservation`, `CognitumIdentityClient`, `sessionAuth` | Connect the mesh to the DEPLOYED Cognitum Spaces service (live `GET /v1/spaces`) under a user's Cognitum OAuth session (identity CLI exchange → Bearer); map Spaces envelopes → Observations. |

## Architecture

```text
input chunk ─▶ Gate.route(chunk, kind) ── top-k by capability
                   │  (AgentRadio: log decision, fold @-mentions — local only)
                   ▼  signed dispatch (ed25519 transport: in-mem fabric | TCP)
              expert peers ──▶ signed AgentFrames ──▶ MixtureState ──▶ ActionGate ──▶ signed output/checkpoint
                                                          │ independence-weighted     ↘ deterministic shadow replica
                                                          ▼ quorum (lineage)              (fenced signed takeover)
```

Every data frame is signed by its origin peer; the public key travels with it and
its fingerprint must match the claimed `peerId`. A tampered or spoofed frame is
dropped and counted in `RouteMetrics.rejectedFrames` — never mixed. `MixtureState`
folds authenticated contributions with deterministic weighting; `ActionGate`
releases an action only from independently-sourced support under an immutable
policy; output envelopes bind protocol and route epochs into a hash chain.

## Does fusion actually help? (measured)

`npm run bench:fusion` runs a deterministic corpus of heterogeneous experts and
reports best-single vs naive-vote vs fused, in two regimes:

| Regime | best-single | naive-vote | mixture (sourceId de-dup) | **mixture + lineage** |
|---|---|---|---|---|
| Independent errors | 66.7% | 100% | 100% | **100%** (+33.3% vs best) |
| Correlated errors | 75.0% | 66.7% ↓ | 66.7% ↓ | **100%** (+25% vs best) |

Honest result: fusing *independent* experts beats the strongest individual — but a
confidently-wrong same-lineage cluster drags naive-vote **and** sourceId de-dup
*below* best-single. Only **lineage-weighted `effectiveSupport`** recovers it.
Independence must be measured by lineage (provider/arch), not just shared sources.
See [ADR-401](../../docs/adr/ADR-401-perpetual-intelligence-machine.md).

## Scripts

| Script | What it runs |
|---|---|
| `npm test` | 134 offline deterministic tests (+ live-gated Cognitum & openssl-gated TLS) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run demo` | 3-peer local mesh, both regimes (`examples/local-mesh.ts`) |
| `npm run mesh` | request→stream→fold end to end (`examples/mesh-run.ts`) |
| `npm run bench` | hot-path throughput: signing/verify/TCP (`examples/bench.ts`) |
| `npm run bench:fusion` | fusion vs best-single (`examples/bench-fusion.ts`) |
| `npm run bench:failover` | 30%-peer-loss recovery time vs the 5 s target (`examples/bench-failover.ts`) |
| `npm run bench:false-alert` | sensor false-alert reduction via corroboration fusion (`examples/bench-false-alert.ts`) |
| `npm run evolve` | one governed flywheel turn (`examples/evolve-run.ts`) |
| `npm run example:custom` | define & run your own pod (`examples/custom-harness.ts`) |

## Status

Reference implementation. Routing, logit mixing / text racing, signed streaming
frames (in-memory + reference TCP), deterministic claim/evidence state,
independence-aware action gating, signed output ordering, replay checkpoints,
fenced shadow takeover, governed flywheel evolution, and the fusion-vs-best-single
benchmark are covered by **134 offline tests**. Not yet demonstrated:
production QUIC/mTLS transport, hostile-network deployment, production witness
persistence, cross-machine multi-peer runs at scale, and ADR-397's end-to-end
quality/latency SLOs. This is **not** a claim of full production readiness or full
ADR acceptance — see each ADR's Status.

## License

MIT © [rUv](https://github.com/ruvnet)
