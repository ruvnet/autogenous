# radio-moe — governed streaming peer expert mesh + streaming mixture of agents

**A real-time streaming, peer-to-peer mixture-of-experts mesh.** Experts live on
different peers, advertise what they're good at, and are routed to per input chunk
by a top-k gate. Their streamed output is combined in the *correct* regime —
mathematically mixed when they share a tokenizer, raced as an ensemble when they
don't.

Built on two grounded primitives, kept strictly separate:

| Plane | Library | Role |
|---|---|---|
| **Control** | [`@metaharness/radio`](https://www.npmjs.com/package/@metaharness/radio) (AgentRadio) | In-process awareness bus — routing decisions + passive teammate-discovery folds at step boundaries. Never crosses the network. |
| **Data** | native `node:crypto` ed25519 | A direct, **signed** peer transport carrying adverts, dispatch requests, and streamed expert frames. Every inbound frame is verified. |

> `@metaharness/radio@0.1.0` is a deterministic in-process bus, **not** a network
> transport (confirmed against the registry). MoRA preserves it as the local
> control plane and adds the signed transport for streamed expert data — see
> [ADR-396](../../docs/adr/ADR-396-peer-expert-protocol-security-and-governed-evolution.md).

## The one distinction that matters

```
logit experts  (shared tokenizer)   →  mixLogits      →  Σ wᵢ·logitsᵢ   ← real MoE
text experts   (heterogeneous)      →  raceTextExperts →  weighted winner ← an ENSEMBLE
```

True mixture-of-experts requires a shared coordinate system: per-token logits over
one vocabulary. Racing free-text experts and picking a winner is an **ensemble, not
a mixture** — there is no space to average `"Concise: …"` and `"Detailed take on:
…"` in. MoRA refuses to conflate them: `mixLogits` throws across incompatible
vocabularies, and the race result is literally typed `regime: 'text-ensemble'`.

## Quick start

```bash
npm install
npm test        # 57 offline, deterministic tests
npm run demo    # a 3-peer local mesh — both regimes
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

## Architecture

```
                 ┌──────────────── peer A (router) ────────────────┐
   input chunk → │  Gate.route(chunk, kind)  ── top-k by capability │
                 │       │                                          │
   control ──────┤  AgentRadio: log decision, fold @-mentions       │
   plane (local) │       │                                          │
                 │       ▼   signed dispatch                        │
                 └───────┼──────────────────────────────┬──────────┘
                         ▼ (ed25519-signed transport)    ▼
                    ┌── peer B ──┐                  ┌── peer C ──┐
                    │  expert e1 │  signed frames   │  expert e2 │
                    └─────┬──────┘  ───────────────▶└─────┬──────┘
                          └──────────► mixLogits / raceTextExperts ◄──┘
```

Every data frame is signed by its origin peer; the public key travels with it, and
its fingerprint must match the claimed `peerId`. A tampered or spoofed frame is
dropped and counted in `RouteMetrics.rejectedFrames` — never mixed.

The [ADR-397](../../docs/adr/ADR-397-autogenous-streaming-mixture-of-agents.md)
reference path adds a request-scoped layer above those frames:

```text
signed AgentFrames → MixtureState → ActionGate → signed output/checkpoint
                                              ↘ deterministic shadow replica
```

`MixtureState` continuously folds authenticated claim/evidence contributions with
deterministic weighting, provenance, contradiction tracking, bounded buffering,
and replica-stable state hashes. `ActionGate` releases an action only from signed,
admitted, independently sourced support under an immutable policy. Output
envelopes bind protocol and route epochs into a hash chain; a shadow retains the
canonical replay checkpoint and can take over only with a signed fencing grant.
Legacy text-primary output still fails closed after its first visible delta.

## Status

Reference implementation — routing, logit mixing/text racing, signed streaming
frames, deterministic claim/evidence state, independence-aware action gating,
signed output ordering, replay checkpoints, and fenced shadow takeover are covered
by **57 passing offline tests**. The included transport remains an in-process test
fabric; live QUIC/WebRTC transport, hostile-network deployment, production witness
persistence, and ADR-397's end-to-end quality/latency benchmarks are not yet
demonstrated. This status therefore does not claim full production readiness or
full ADR acceptance.

## License

MIT © [rUv](https://github.com/ruvnet)
