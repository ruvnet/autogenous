# constitution — the immutable, hash-pinned rulebook for governed AI

`constitution` is the governance plane of [Autogenous](../), a self-evolving
AI-defense runtime in Rust. It holds the one thing the evolving system is **not
allowed to change**: identity, authority ceilings, prohibited effects, hard
promotion gates, the signing policy (which keys may judge and promote), and the
shutdown rule.

Immutability is not a promise — it's enforced by **content-hash pinning**. Every
genome carries `constitution: <hash>`, and the [`verifier`](../verifier) refuses
any artifact whose pinned hash doesn't match the deployed constitution. Change the
rules and every in-flight artifact stops verifying until it's re-pinned.

> Keywords: AI governance, policy-as-code, immutable constitution, hash pinning,
> externally governed autonomy, allow-list signing keys, Rust.

## What's inside

- **`Constitution`** — the document itself: `identity`, `authority_ceiling`,
  `prohibited_effects`, `hard_gates`, pinned judge/controller keys, effective time.
- **`.hash()`** — the content hash every genome pins to.
- **`.prohibits(effect)`**, **`.pinned_judges()`**, **`.pinned_controllers()`** —
  the checks the verifier and promotion path consult.
- **`ConstitutionChange` / `.check()`** — models a *governed* rule change (new
  document, signatures, effective time, migration). This crate can **represent and
  check** a change; it can never **apply** one from inside the runtime.

## The load-bearing rule

**Nothing in the evolutionary system may mutate the constitution.** Constitutional
change happens out-of-band, under human/multi-party governance — exactly the
authority the self-improving loop must never grant itself.

## Example

```rust
use constitution::Constitution;

let pinned = genome.constitution;            // hash carried by the artifact
if pinned != live_constitution.hash() {
    // reject: artifact was built against a different rulebook
}
assert!(live_constitution.prohibits("pii_egress"));
```

## Where it fits

[`verifier`](../verifier) and [`envelope`](../envelope) enforce it on every
promotion; [`agl-types`](../agl-types) genomes pin to it.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 §4.1 in [`docs/adr/`](../../docs/adr).
