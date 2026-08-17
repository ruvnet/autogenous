# promotion — staged canary rollout with automatic rollback (Rust)

`promotion` is the rollout controller of [Autogenous](../), a self-evolving
AI-defense runtime in Rust. It's a **deterministic state machine** that walks a
verified defense through a staged canary — `1% → 10% → 50% → 100%` — advancing only
while measured fitness keeps passing the constitutional hard gates, and **rolling
back automatically** on the first violation.

Two asymmetries make it safe: **promotion requires a signed, single-use token;
rollback requires nothing** (it's always the safe direction).

> Keywords: canary deployment, progressive delivery, automatic rollback, staged
> rollout, safe promotion, feature-gate state machine, AI deployment safety, Rust.

## What's inside

- **`CanaryController`** — `observe(fitness)` feeds one measurement and returns a
  `Decision` (`Hold` / `Advance` / `ReadyForPromotion` / `RollBack`).
- **`promote(&VerifiedPromotion, now)`** — finalize the rollout. Accepts **only**
  the single-use token from [`envelope`](../envelope), and enforces binding,
  expiry, single-use, and "canary complete" before it flips to `Promoted`.
- **`STAGES`** — the `[1, 10, 50, 100]` traffic ladder.

## What it never does

The controller **never evaluates and never generates** — it only consumes verdicts
and measurements (evaluator separation, ADR-392 §11). And there are **zero
unsigned promotions**: without a valid `VerifiedPromotion`, a candidate never
becomes `Promoted`, no matter how healthy it looks.

## Example

```rust
use promotion::{CanaryController, Decision};

let mut canary = CanaryController::new(candidate_id, rollback_target, gates, 2);
loop {
    match canary.observe(&measure_current_stage()) {
        Decision::RollBack { reason } => { /* auto-reverted */ break; }
        Decision::ReadyForPromotion   => { canary.promote(&verified_token, now)?; break; }
        _ => continue,
    }
}
```

## Where it fits

Consumes the [`envelope`](../envelope) token, actuates through
[`deployment`](../deployment), is made durable by [`ledger`](../ledger), and is
driven by [`runtime`](../runtime) (see `run_canary_full` for the fully-guarded path).

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 Phase 6, ADR-403 in [`docs/adr/`](../../docs/adr).
