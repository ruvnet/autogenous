# witness — content addressing + ed25519 signing + tamper-evident chains (Rust)

`witness` is the cryptography plane of [Autogenous](../), a governed, self-evolving
AI-defense runtime. It gives every piece of evidence a **content hash**, a **real
ed25519 signature**, and a place in an **append-only, tamper-evident chain** — so
provenance is verifiable, not asserted.

If another crate ever held a placeholder `signature: "sig"` string, this is the
crate that replaced it with actual cryptography.

> Keywords: ed25519 Rust, content-addressed storage, SHA-256 canonical hashing,
> tamper-evident log, cryptographic provenance, signed audit chain, AI provenance.

## What's inside

- **`content_hash<T: Serialize>`** — SHA-256 over the *canonical JSON* of any
  serializable value. Same bytes on every machine → the same hash → lineage that
  reconciles across deployments.
- **`SigningAuthority`** — an ed25519 keypair. Generator, evaluator, and promotion
  controller each hold a **separate** authority, so signatures are attributable
  and non-forgeable.
- **`WitnessSeal` / `verify_seal`** — a detached signature binding one subject hash.
- **`WitnessRecord` / `verify_chain`** — an append-only record that commits to the
  previous record's hash; `verify_chain` checks every signature *and* every link,
  returning the index of the first bad record.

## Example

```rust
use witness::{SigningAuthority, content_hash, verify_hex};

let authority = SigningAuthority::from_seed("judge-a", [7u8; 32]);
let subject   = content_hash(&my_artifact);         // stable across machines
let sig       = authority.sign_hex(subject.as_bytes());

assert!(verify_hex(&authority.public_hex(), subject.as_bytes(), &sig));
```

## Why it matters

Content addressing + separated signing authorities + a linked chain are what let
Autogenous make a strong claim: **you can independently reconstruct and verify the
entire history** of any deployed defense — no trusted database, no editable log.

## Where it fits

Almost every crate depends on `witness`: [`antibody`](../antibody) and
[`envelope`](../envelope) sign their packages with it, [`ledger`](../ledger) and
[`lineage`](../lineage) build their chains on it, and [`deployment`](../deployment)
seals rollback receipts with it.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 §13 in [`docs/adr/`](../../docs/adr).
