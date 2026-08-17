# midstream-adapter — turn a live LLM/agent stream into signed incident evidence

`midstream-adapter` is the observation plane of [Autogenous](../), a self-evolving
AI-defense runtime in Rust. It's the bridge between a **live LLM or agent output
stream** and the evidence pipeline: feed it stream chunks (or raw provider
Server-Sent-Events lines), and when an armed [`antibody`](../antibody) detector
fires, it emits a structured **`Incident`** — trace identity, matched conditions,
and *derived, privacy-preserving* evidence.

It also understands **temporal** attacks: beyond substring detectors, it can arm
sequence-similarity checks (via the published `midstreamer-temporal-compare`
crate) that catch reordered or obfuscated injections a naive `contains` would miss.

> Keywords: LLM output monitoring, streaming prompt-injection detection, SSE
> parsing, real-time agent guardrails, privacy-preserving evidence, Rust.

## What's inside

- **`StreamObserver`** — arm antibodies, then `observe_chunk` / `observe_sse` a
  live stream; get back a `Vec<Incident>`.
- **`Incident`** — the structured detection: matched condition names, chunk length,
  a redacted excerpt, and `to_receipt()` for the evidence plane.
- **`Provider` / `sse_text`** — parse OpenAI/Anthropic-style SSE lines to text.
- **`arm` / `arm_temporal`** — register substring or temporal-sequence detectors.

## Boundaries (by design)

- **Observation only.** The adapter never mutates the stream and never acts — it
  *reports*. Containment is a recommendation carried to the enforcement layer,
  bounded by the antibody's own authority.
- **Derived evidence by default.** An incident carries matched-condition names and
  a redacted excerpt — never the full raw output unless policy explicitly allows.

## Example

```rust
use midstream_adapter::{StreamObserver, Provider};

let mut obs = StreamObserver::new("trace-42");
obs.arm(&antibody, now_unix_secs)?;

for line in provider_sse_lines {
    for incident in obs.observe_sse(Provider::OpenAi, &line) {
        // ship incident.to_receipt() to the evidence plane
    }
}
```

## Where it fits

Its `Incident` evidence feeds [`generator`](../generator) (to synthesize new
defenses) and the [`witness`](../witness)-backed evidence chain.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-393 MVP #2 in [`docs/adr/`](../../docs/adr).
