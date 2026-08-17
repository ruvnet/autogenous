# ledger — a durable, tamper-evident promotion ledger for crash recovery (Rust)

`ledger` is the durable-recovery plane of [Autogenous](../), a self-evolving
AI-defense runtime in Rust. A promotion is single-use *within a process*; this
crate makes that guarantee **survive a restart**.

It's an **append-only, fsync'd, hash-chained** log of every promotion actually
committed — so replay protection, authorized-state reconstruction, and tamper
evidence all outlive a crash, with no manual editing.

> Keywords: append-only log, write-ahead durability, fsync, hash chain, replay
> protection, crash recovery, tamper-evident audit, checkpoint, Rust.

## What's inside

- **`PromotionLedger`** — `open()` replays and **cryptographically verifies** the
  whole chain (ed25519 signatures + prev-hash links) and rebuilds the
  consumed-nonce set. `record_promotion(...)` fsyncs a line *before* advancing
  in-memory state, and refuses an already-recorded nonce (durable replay guard).
- **`Checkpoint`** — a crash-safe single-value snapshot (temp-write + fsync +
  atomic rename). Save an in-flight canary controller after each step so a crash
  at the 50% stage **resumes there** instead of restarting from 1%.

## Three guarantees

1. **Durable replay protection** — a committed nonce is rejected forever, across
   restarts *and* across fresh controllers.
2. **Restart reconstruction** — reopening rebuilds the authorized state (consumed
   nonces + promotion history) with no manual edits.
3. **Tamper evidence** — editing a payload breaks its record's hash commitment;
   forging or reordering a line breaks the signed chain. All caught at `open()`.

## Example

```rust
use ledger::{PromotionLedger, Checkpoint};

let mut led = PromotionLedger::open("promotions.jsonl")?;   // verifies + reconstructs
if !led.contains_nonce(token_nonce) {
    // ...promote...
    led.record_promotion(&controller, record, now)?;        // fsync'd, single-use
}
Checkpoint::save("canary.ckpt", &canary_controller)?;       // resume after a crash
```

## Where it fits

Records the tokens minted by [`envelope`](../envelope) and consumed by
[`promotion`](../promotion); wired into [`runtime`](../runtime)'s durable rollout
paths. Chains are built on [`witness`](../witness).

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-403 item 4 in [`docs/adr/`](../../docs/adr).
