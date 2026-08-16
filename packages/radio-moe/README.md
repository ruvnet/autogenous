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
> [ADR-396](./docs/adr/ADR-396-mora-streaming-moe-p2p.md).

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
npm test        # 13 offline, deterministic tests
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

## Status

Research prototype — the routing, mixing, signing, and two-plane wiring are real
and tested; experts are reference stubs behind the `Expert` interface, and the
live WebRTC transport (trystero) is specified in ADR-396, not yet shipped. This
package is TypeScript by explicit request (the `radio` npm pin).

## License

MIT © [rUv](https://github.com/ruvnet)
