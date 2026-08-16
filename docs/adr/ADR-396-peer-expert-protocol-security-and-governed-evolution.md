# ADR-396 — Peer expert protocol security and governed evolution

- Status: Accepted for reference implementation
- Date: 2026-08-16
- Decision owners: Autogenous maintainers
- Related: ADR-392, ADR-395 (this repo), ADR-397

## Context

A real-time expert mesh (ADR-395) adds a network-facing execution boundary. An
untrusted peer can attempt identity spoofing, replay, route manipulation,
oversized frames, false quality claims, tokenizer confusion, slow-stream
exhaustion, output poisoning, cancellation suppression, and Radio thread flooding.
Autogenous must govern what may evolve **without** allowing routing optimization to
mutate these safety controls.

## Decision

Adopt a versioned, signed, deadline-bound protocol with separate constitutional,
routing, transport, and expert concerns.

### Signed envelope

Every peer message commits to:

```text
version · event_id · sender_peer · recipient_peer · request_id
route_epoch · sender_sequence · issued_at · expires_at · kind · payload
```

The signature covers the **canonical** representation of every field except the
signature itself. The receiver verifies, in this order: shape and size (before
expensive work), then recipient, time, configured sender key, signature, replay
id, and monotonic sequence.

### Message classes

| Kind | Direction | Durable effect | Replay handling |
|---|---|---|---|
| `request.open` | Origin → expert | Starts bounded computation | Strictly once |
| `request.cancel` | Origin → expert | Stops computation | Idempotent |
| `stream.delta` | Expert → origin | None until aggregated | Deduplicate and order |
| `stream.end` | Expert → origin | Completes one stream | Idempotent terminal |
| `stream.error` | Expert → origin | Marks one route failed | Idempotent terminal |

**No transport message may grant a capability, admit a peer, change a
constitution, promote a mutation, or modify a verifier key.**

### Expert admission

A manifest is locally routable only when: (1) its canonical hash matches an
admission receipt subject; (2) the receipt was signed by a **configured
constitutional verifier**; (3) receipt and manifest are unexpired; (4) manifest
constitution equals the node constitution; (5) peer, capability, model, tokenizer,
cost, latency, quality, trust, and concurrency fields pass structural bounds.
Remote announcements may request *evaluation* but never enter the active registry
directly.

### Evolvable vs non-evolvable

Autogenous **may** propose changes to: ranking weights within constitutionally
bounded ranges; `topK`, quorum, token deadline, and shadow policy within fixed
ceilings; expert selection among already-admitted manifests; per-capability route
profiles. Every routing mutation must name its parent, evaluation population,
objectives, cost, latency, quality, failure rate, expiry, and rollback route
profile.

Autogenous **may not** mutate: trust roots or signing algorithms; admission
requirements; maximum frame/prompt/replay/concurrency bounds beyond constitutional
ceilings; signature/expiry/recipient/sequence/replay checks; text fail-closed
semantics after first output; capability or jurisdiction constraints.

## Threat model

| Threat | Attack | Control | Residual risk |
|---|---|---|---|
| Spoofing | Peer claims another identity | Configured Ed25519 key + signed envelope | Key theft |
| Tampering | Modify prompt or delta | Signature over complete envelope | Compromised signer emits harmful content |
| Repudiation | Deny sending a route event | Signed event + future witness adapter | Local logs not yet durable |
| Information disclosure | Read prompt on direct TCP | Trusted network only in reference adapter | Production requires encryption |
| Denial of service | Oversized frames, slow experts, replay flood | Size bounds, deadlines, replay window, topK ceiling | Distributed peers can exhaust origin sockets |
| Elevation of privilege | Self-admit a powerful expert | Verifier-signed admission receipt | Verifier compromise is constitutional failure |
| Route poisoning | Publish false quality/low cost | Signed verifier receipt + measured evaluation | Stale evaluations can misroute |
| Tokenizer confusion | Mix incomparable logits | Exact tokenizer id gate | Same id can hide drift without artifact hashes |
| Semantic corruption | Switch text experts mid-answer | Failover only before first emitted delta | Primary can still emit plausible harmful output |
| Radio flooding | Send huge control content | Local-only metadata adapter + content bound | Compromised local process can flood memory |

## Protocol invariants

1. `sender != recipient` for network messages.
2. `issuedAt <= now + clockSkew` and `now < expiresAt`.
3. Event ids are unique within the bounded replay horizon.
4. Sequence increases per `(sender, request)`.
5. Only configured peer keys verify network envelopes.
6. Only configured verifier keys admit manifests.
7. Text output has exactly one visible primary.
8. Logit output requires the declared quorum and one tokenizer.
9. Cancellation, expiry, and rollback only *reduce* active work.
10. Radio never becomes evidence of identity merely because it contains a sender string.

## Failure semantics

- Bad shape/recipient/signature/replay/sequence → reject + record metadata-only reason.
- Unknown or expired expert → bounded error, no invocation.
- Text primary failure **before** output → select next admitted shadow.
- Text primary failure **after** output → terminate with explicit error.
- Logit quorum timeout → terminate (never silently lower quorum).
- Transport loss → cancel local request state at deadline; do not retry
  `request.open` with a new event id unless the origin explicitly creates a new
  attempt id.

## Performance budget

| Operation | Reference target |
|---|---|
| Envelope signature verification | < 1 ms p99 per frame |
| Router selection over 1,000 manifests | < 2 ms p99 |
| Local Radio metadata append | < 100 µs p99 |
| Added LAN first-token overhead | < 5 ms p99 (excl. model time) |
| Token quorum wait | Configurable, default 25 ms |
| Cancellation propagation | < 100 ms p99 on healthy links |

The signature-per-delta reference profile prioritizes integrity over throughput. A
production profile may sign bounded hash-chained batches of deltas, provided the
receiver authenticates the batch before exposing output and preserves per-request
ordering.

## Conformance tests

Valid streaming; deterministic routing; weighted logit mixing; incompatible
tokenizers; forged signatures; replay; expired envelopes; reordered sequences;
oversized frames; missing quorum; primary failure before output; primary failure
after output; cancellation; control-plane data minimization.

## Remaining production work

1. Replace direct TCP with QUIC + mutual TLS or a Noise-secured transport.
2. Bind tokenizer id to a signed tokenizer artifact hash.
3. Persist replay/sequence checkpoints across restarts where exactly-once matters.
4. Connect transport events to the Rust witness and lineage crates.
5. Per-peer rate limits, circuit breakers, load proofs, admission revocation propagation.
6. Benchmark Ed25519 per frame vs signed hash-chain batches.
7. Fuzz framing, canonicalization, and payload decoders.

## Acceptance test

Submit one valid `request.open`, then submit the same envelope again, a copy with
one changed payload byte, and a newly signed copy with a lower sequence. **Exactly
one** expert invocation may occur, and the three rejected attempts must expose only
request id, peer id, and rejection class in Radio.
