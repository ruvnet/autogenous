# runtime — the self-running AI-defense loop (observe → verify → canary → rollback)

`runtime` is the engine of [Autogenous](../), a self-evolving AI-defense runtime in
Rust. It runs the whole loop end to end: a novel attack becomes a **population of
generated candidate defenses**, each **independently judged and signed**, the
best **cryptographically verified**, then **canary-rolled-out** with **timed,
automatic rollback** on any regression — and it measures the SLOs while doing it.

The runtime **never fabricates a fitness number.** Judges measure candidate vs.
parent on the same corpus and sign the results; the controller signs the
promotion; the verifier admits only on independently verified, content-bound
evidence. Trust is earned per step, cryptographically.

> Keywords: autonomous defense loop, self-healing AI, closed-loop security,
> signed evaluation, canary + rollback orchestration, SLO measurement, Rust.

## What it does

`Runtime::defend(evidence)` runs **observe → generate → judge-sign → verify →
select**, returning the chosen signed defense (or none). Then the canary runners
drive the staged rollout:

- **`run_canary`** — the staged `1/10/50/100%` rollout with timed automatic rollback.
- **`run_canary_guarded`** — adds a per-target promotion **lock** (no split-brain).
- **`run_canary_checkpointed`** — adds a durable **mid-rollout checkpoint** (resume
  after a crash).
- **`run_canary_full`** — the single **supported** path: lock **+** durable ledger
  **+** checkpoint, composed.

## The verifiable execution loop (ADR-403)

`run_canary_full` composes all three ADR-403 protections so that the artifact you
evaluated is provably the artifact that reaches production, promotable **once**,
recoverable after a crash:

- **lock** — fence concurrent promotions to the same target;
- **ledger** — durable, cross-restart replay protection + signed authorized-state;
- **checkpoint** — resume a mid-rollout canary instead of restarting.

## Example

```rust
use runtime::{Runtime, PromotionLockRegistry, Slos};

let outcome = rt.defend(&attack_evidence, &clock);
let chosen  = outcome.chosen.expect("a signed, verified defense");

let lock = PromotionLockRegistry::new();
let result = rt.run_canary_full(
    &lock, "canary.ckpt", &chosen.promotion, &clock, &mut adapter,
    |_| measure(), /* obs/stage */ 2, /* max */ 12, Slos::default(),
    Some(&mut ledger),
);
// result.outcome: promoted through 1/10/50/100%, or auto-rolled-back within SLO
```

## Where it fits

`runtime` depends on every other crate: [`generator`](../generator),
[`evaluator`](../evaluator), [`verifier`](../verifier), [`envelope`](../envelope),
[`promotion`](../promotion), [`deployment`](../deployment), [`ledger`](../ledger),
[`lineage`](../lineage), and [`witness`](../witness). It's the box that wires the
pipeline into one governed, self-running system.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 §9/§14, ADR-393, ADR-403 in [`docs/adr/`](../../docs/adr).
