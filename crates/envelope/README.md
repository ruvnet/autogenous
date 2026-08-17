# envelope — the cryptographically-closed promotion path for AI evolution

`envelope` is the trust core of [Autogenous](../), a self-evolving AI-defense
runtime in Rust. It answers one demand from the security review: **a promotion
must depend on independently verified, content-bound evidence — never a
caller-supplied boolean, an `Option<String>` "signature", or a separate
"declared effects" argument.**

Nothing here trusts a number handed in by a generator. It binds three signed,
content-addressed objects into a closed check, and — as of ADR-403 — mints a
**single-use promotion token** that is the *only* thing allowed to promote a
candidate.

> Keywords: verifiable promotion, content-bound manifest, signed evaluation
> receipt, ed25519 quorum, single-use token, supply-chain integrity for AI, Rust.

## What's inside

- **`CandidateManifest`** — the object everything binds to. Effects, capabilities,
  rollback target, and invariant proofs live *inside* it, so its hash commits to
  all of them.
- **`EvaluationReceipt`** — a judge's **signed** measurement binding *candidate and
  parent* on the same corpus, with sample count. Promotion requires **≥2 distinct
  pinned judges**.
- **`PromotionEnvelope`** — the signed promotion authorization from a pinned controller.
- **`verify_promotion(...)`** — the closed check: returns **every** violation
  (empty = admissible).
- **`VerifiedPromotion` + `verify_promotion_artifact(...)`** (ADR-403) — an
  **opaque, single-use** token that can *only* be created by a zero-rejection
  verification. It binds candidate / parent / corpus / receipts / policy / expiry /
  rollback, so "what was verified" and "what gets promoted" can never drift apart.

## The closure guarantee

`verify_promotion_artifact` returns a `VerifiedPromotion` **only** when every
independent check passes. The [`promotion`](../promotion) controller accepts that
token and nothing else — so a candidate cannot be promoted unless it provably
cleared verification, bound to exactly that artifact, exactly once.

## Example

```rust
use envelope::verify_promotion_artifact;

match verify_promotion_artifact(&constitution, &parent, &manifest,
                                &receipts, &envelope, &proofs, now) {
    Ok(token) => canary.promote(&token, now)?,   // the ONLY way to promote
    Err(violations) => eprintln!("blocked: {violations:?}"),
}
```

## Where it fits

Builds on [`witness`](../witness), [`constitution`](../constitution),
[`evaluator`](../evaluator), [`antibody`](../antibody); its token is consumed by
[`promotion`](../promotion) and recorded by [`ledger`](../ledger).

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-394 / ADR-403 in [`docs/adr/`](../../docs/adr).
