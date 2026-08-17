# agl-types — the Autogenous Genome Language (typed mutations for safe AI evolution)

`agl-types` is the type foundation of [Autogenous](../), a governed, self-evolving
AI-defense runtime in Rust. It defines the **Autogenous Genome Language (AGL)**:
the vocabulary in which a self-improving system describes a change to itself.

The core idea: **a mutation is not a text patch.** It is a *typed transformation
between two valid genomes* that declares what it changes, why it should work, where
it applies, what authority it needs, which invariants it preserves, when it
expires, and how to reverse it. Because that is all in the type system, unsafe
changes are rejected structurally — not by a linter, a review, or a prompt.

> Keywords: typed AI mutation, safe self-modification, capability/authority model,
> AI governance types, Rust, fitness gates.

## What's inside

- **`Genome`** — a valid configuration of the system, pinned to a constitution hash.
- **`Mutation`** — a typed, reversible, expiring change with a required authority,
  a scope, preserved invariants, and a rollback target.
- **`Authority`** — a capability ladder (`ObserveOnly` → `Constitutional`). A
  mutation may request *less* than its parent's ceiling, never more.
- **`FitnessVector` + `HardGates`** — multi-dimensional quality (task, safety,
  governance, reliability, overhead, false-positive rate, regressions) with
  hard promotion gates.
- **`HardInvariant`** — properties (e.g. tenant isolation) that must hold before
  and after a change.

## Two rules enforced in the types

1. **Authority never silently expands** — `Mutation::admissible` rejects any
   mutation requesting more authority than its parent genome allows.
2. **Nothing promotes on vibes** — `FitnessVector::passes_hard_gates` is the
   floor every candidate must clear.

## Example

```rust
use agl_types::{Mutation, Genome};

// Reject a mutation that tries to grab more authority than its parent, or that
// is missing a rollback target / has expired.
match mutation.admissible(&parent_genome, now_unix_secs) {
    Ok(())   => { /* structurally admissible — hand to the verifier */ }
    Err(why) => eprintln!("inadmissible: {why:?}"),
}
```

## Where it fits

`agl-types` sits under everything: [`witness`](../witness) signs these types,
[`verifier`](../verifier) admits them, [`evaluator`](../evaluator) scores their
fitness, and [`runtime`](../runtime) drives them through the loop.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 / ADR-393 in [`docs/adr/`](../../docs/adr).
