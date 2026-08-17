# Autogenous Crates — a governed, self-evolving AI-defense runtime in Rust

**Autogenous** is a self-improving security runtime for AI systems, written in Rust.
It turns a novel attack — a prompt-injection attempt, a jailbreak, an anomalous
agent action — into a **cryptographically signed, independently verified defense**,
rolls that defense out through a staged canary, and **automatically rolls it back**
the moment it regresses. Every step leaves a tamper-evident, content-addressed
trail, so you can reconstruct exactly *what* was deployed, *why* it was allowed,
and *who* signed off.

Think of it as an immune system for LLM and agent pipelines: detect → generate a
candidate defense → evaluate it independently → verify it against a frozen policy →
canary it → promote or roll back — all under cryptographic governance that the
evolving system itself cannot weaken.

> Keywords: AI safety, LLM security, prompt-injection defense, self-healing agents,
> governed autonomy, ed25519 provenance, canary deployment, automatic rollback,
> verifiable AI, Rust security crates.

## The pipeline (crate by crate)

Each crate is one small, independently testable stage. Data flows top to bottom;
every stage is separable so an independent operator can re-check any decision.

| Stage | Crate | What it does |
|-------|-------|--------------|
| **Types** | [`agl-types`](./agl-types) | The Autogenous Genome Language: genomes, **typed mutations**, authority classes, hard invariants, vector fitness. Authority can never silently expand. |
| **Crypto** | [`witness`](./witness) | SHA-256 content addressing + **ed25519** signing + an append-only, tamper-evident **witness chain**. |
| **Policy** | [`constitution`](./constitution) | The immutable, **hash-pinned**, externally governed rulebook. The evolving system may read it, never mutate it. |
| **Adaptation** | [`antibody`](./antibody) | A signed, **expiring, capability-constrained** defense package — trigger, detector, evidence, containment, rollback target. |
| **Observe** | [`midstream-adapter`](./midstream-adapter) | Turns a live LLM/agent stream into structured, **privacy-preserving incidents** when armed detectors fire. |
| **Generate** | [`generator`](./generator) | Synthesizes a **diverse population** of candidate defenses from attack evidence — **without ever seeing the evaluator's labels**. |
| **Evaluate** | [`evaluator`](./evaluator) | Replays a candidate detector over labeled corpora → recall, false-positive rate, and **Wilson-interval uncertainty**. |
| **Verify** | [`verifier`](./verifier) | Composes every structural check into **one admission verdict** with the complete list of violations. |
| **Close** | [`envelope`](./envelope) | The **cryptographically-closed promotion path**: content-bound manifests, signed judge receipts, and a single-use `VerifiedPromotion` token. |
| **Roll out** | [`promotion`](./promotion) | The **canary controller**: staged `1% → 10% → 50% → 100%` rollout with automatic rollback on any gate violation. |
| **Actuate** | [`deployment`](./deployment) | **Two-phase verified rollback** (command → confirm hash + health → signed receipt) and a per-target promotion lock. |
| **Persist** | [`ledger`](./ledger) | A durable, fsync'd, hash-chained **promotion ledger** + crash-safe checkpoint: replay protection and state reconstruction across restarts. |
| **Provenance** | [`lineage`](./lineage) | Append-only, content-addressed **ancestry DAG** + quality-diversity archive for full forensic replay. |
| **Loop** | [`runtime`](./runtime) | The self-running **observe → generate → evaluate → verify → canary → promote / rollback** loop, with measured SLOs. |

## Design principles (enforced in the types, not by convention)

- **Authority never silently expands.** A mutation may request *less* power than
  its parent, never more.
- **The generator can't grade its own homework.** It never sees the labeled
  corpus the evaluator judges against — the strongest defense against reward hacking.
- **No booleans of trust.** Promotion depends on independently verified,
  content-bound, signed evidence — never a caller-supplied `true` or a placeholder
  `"signature"` string.
- **Reversible by default.** Every adaptation carries a rollback target and an
  expiry; rollback is executed and *confirmed*, not merely decided.
- **Everything is content-addressed.** Same bytes → same hash → a history that
  reconciles across machines.

## The verifiable execution loop (ADR-403)

The newest crates — [`envelope`](./envelope), [`deployment`](./deployment),
[`ledger`](./ledger) — close the loop so that **the artifact that gets evaluated
is provably the exact artifact that reaches production**, promotable **once**,
recoverable after a crash. See
[`docs/adr/ADR-403-verifiable-execution-loop.md`](../docs/adr/ADR-403-verifiable-execution-loop.md).

## License

MIT — see [LICENSE](../LICENSE). Design records live in [`docs/adr/`](../docs/adr).
