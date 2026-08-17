# verifier — one admission verdict for a self-evolving AI system (Rust)

`verifier` is the admission gate of [Autogenous](../), a self-evolving AI-defense
runtime in Rust. It composes **every structural check into a single verdict**:
constitution pinning, typed-mutation admission (authority, invariants, rollback,
expiry), prohibited effects, and the hard fitness gates.

It returns the **complete list of violations**, not just a pass/fail — a failure
you can act on, not a mystery.

> Keywords: policy verification, admission control, AI safety gate, deterministic
> verifier, capability checking, explainable rejection, Rust.

## What's inside

- **`verify(...)`** — the one call. Give it the constitution, parent genome,
  proposed mutation, prohibited-effect list, and optional fitness; get a `Verdict`.
- **`Verdict`** — `admissible` / `promotable` plus the full `violations` list.

## Why it's deterministic and separable

The verifier holds **no mutable state** and takes everything as input (ADR-392
§3.4). The same inputs always produce the same verdict — so an **independently
operated** verifier can re-check any promotion after the fact. It is deliberately
decoupled from the generator (which proposes) and the runtime (which drives), so
no single component can both propose *and* approve.

## Example

```rust
use verifier::verify;

let verdict = verify(&constitution, &parent, &mutation, &prohibited, Some(&fitness), now);
if verdict.admissible && verdict.promotable {
    // structurally clean — hand to the cryptographic envelope
} else {
    eprintln!("rejected: {:?}", verdict.violations);
}
```

## The acceptance property

Even when *everything else* recommends a change — perfect fitness, healthy
rollout — the verifier still rejects a mutation that tries to expand capability
beyond its parent's ceiling. Safety is not a tunable score.

## Where it fits

Sits between [`agl-types`](../agl-types)/[`constitution`](../constitution) and the
[`envelope`](../envelope) closure that adds cryptographic evidence on top.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 Phase 3 in [`docs/adr/`](../../docs/adr).
