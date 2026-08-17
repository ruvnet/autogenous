# antibody — signed, expiring, capability-constrained AI defenses

`antibody` defines the **Autogenous Antibody Package (AAP)** — the unit of defense
in [Autogenous](../), a self-evolving AI-defense runtime in Rust. Borrowing from
the immune system: an antibody is a *complete, self-describing, reversible*
response to a threat, not just a rule.

Each antibody carries its **trigger**, a serializable **detector**, signed
**evidence**, a **containment** response, a **regression corpus** reference, a
**fitness envelope**, its **lineage**, an **expiry**, and a **rollback target** —
and it's ed25519-signed over the whole package, so tampering with any field breaks
the signature.

> Keywords: prompt-injection detector, jailbreak defense, capability-constrained
> adaptation, expiring security policy, signed detection rule, LLM guardrail, Rust.

## What's inside

- **`Antibody`** — the package: trigger, detector, evidence, containment,
  requested authority, prohibited effects, expiry, rollback target, signature.
- **`Detector`** (in `antibody::detector`) — a small, **total, sandbox-safe**
  combinator algebra (`Contains`, `AnyOf`, `All`, `Any`, `Not`, `LengthBetween`)
  with hard resource ceilings. It's pure data, so it ships inside a signed package
  and behaves identically on every deployment. No regex engine, no user code.
- **`Trigger` / `Containment`** — with a structural safety rule (below).

## Two rules enforced structurally

1. **A statistical trigger can't authorize an irreversible action** — learned
   triggers may only quarantine, buffer, cancel, reduce authority, or start a
   governed evaluation, never terminate.
2. **Every antibody expires** unless renewed by fresh evidence. There is no
   "permanent" adaptation.

## Example

```rust
use antibody::detector::Detector;

let d = Detector::Contains { needle: "ignore previous instructions".into() };
d.validate().unwrap();                        // resource-bounded, total
assert!(d.matches("please IGNORE Previous Instructions"));

// A signed package only verifies against its issuer's pinned key:
assert!(antibody.verify_signature(&issuer_pubkey_hex));
```

## Where it fits

[`generator`](../generator) synthesizes antibodies, [`evaluator`](../evaluator)
scores their detectors, [`midstream-adapter`](../midstream-adapter) arms them
against a live stream, and [`witness`](../witness) signs them.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 §8 in [`docs/adr/`](../../docs/adr).
