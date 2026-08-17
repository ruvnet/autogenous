# deployment — two-phase verified rollback + concurrent-promotion fencing (Rust)

`deployment` is the actuation seam of [Autogenous](../), a self-evolving
AI-defense runtime in Rust. It turns "rollback" from a status flag into a **real,
confirmed transition**, and it fences concurrent rollouts so two candidates can't
fight over the same target.

The security review's objection was blunt: *rollback was represented, not
executed or verified.* This crate fixes that — nothing here trusts a boolean.

> Keywords: verified rollback, traffic restoration, deployment adapter, canary
> actuation, promotion lock, split-brain prevention, signed receipt, Rust.

## What's inside

- **`DeploymentAdapter`** — the trait a real router/orchestrator implements
  (`active`, `health`, `deploy`, `restore`). `InMemoryAdapter` is the deterministic
  reference used by tests and the demo.
- **`verified_rollback(...)`** — two-phase: (1) command restore, (2) **confirm** the
  active artifact hash *and* its health, (3) emit a **signed `RollbackReceipt`**.
  A restore that reaches the target but is unhealthy does **not** produce a valid
  rollback — it escalates instead of silently "succeeding".
- **`PromotionLockRegistry`** (ADR-403 item 2) — a thread-safe, per-target lock so
  at most one rollout is in-flight to a given target. Fails fast on contention,
  releases on guard drop.

## Why "verified"

A `RollbackReceipt.is_valid()` is true only if the ed25519 seal verifies, it binds
the restored artifact hash, **and** the restored artifact is confirmed healthy. A
forged or mismatched receipt fails. The rollback is proven, not asserted.

## Example

```rust
use deployment::{verified_rollback, InMemoryAdapter, PromotionLockRegistry};

let receipt = verified_rollback(&mut adapter, &controller, parent_hash, now)?;
assert!(receipt.is_valid());            // traffic actually restored + healthy

let lock = PromotionLockRegistry::new();
if let Some(_guard) = lock.acquire(target) {
    // exclusive rollout to `target`; a second acquire returns None (fenced)
}
```

## Where it fits

Actuates the [`promotion`](../promotion) canary; its lock is composed with the
durable [`ledger`](../ledger) in [`runtime`](../runtime)'s `run_canary_full`.

## License

MIT — see [LICENSE](../../LICENSE). Design: review finding #6, ADR-403 in [`docs/adr/`](../../docs/adr).
