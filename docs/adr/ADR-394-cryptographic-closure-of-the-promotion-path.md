# ADR-394 — Cryptographic closure of the promotion path (security-review remediation)

- Status: Accepted — Implemented
- Date: 2026-08-16
- Supersedes the decorative-security behaviour described in ADR-392 §9/§10 for the promotion transition.
- Related: ADR-392 (the AGL/AAP contract), ADR-393 (product thesis).

## Context

An independent security review of the prototype found the security-critical
transitions were **decorative**: `promote("")` reached `Promoted`; the verifier
trusted a caller-supplied `FitnessVector`; "beats parent" was absent; effects,
rollback targets, and invariant preservation were self-asserted; and the
constitutional quorum counted duplicate signers. The review's verdict:

> Make every security-relevant transition depend on independently verified,
> content-bound evidence, never caller-supplied booleans or strings.

Its acceptance bar: a maximally-malicious candidate (perfect *declared* fitness,
duplicated signers, arbitrary rollback target, empty promotion signature, omitted
prohibited effects, self-asserted invariants) must be **rejected for ≥6
independent reasons before any canary traffic**.

## Decision

Introduce the **`envelope`** crate — the cryptographically-closed promotion path
— and route the runtime through it. Three signed, content-addressed objects and
one collecting verifier:

- **`CandidateManifest`** — the object everything binds to; its hash commits to
  the mutation, the exact detector bytes, the **declared effects & capabilities**,
  the **rollback target**, and the **invariant proof references** (findings #4/#5/#6).
- **`EvaluationReceipt`** — a judge's **ed25519-signed** measurement binding
  **candidate *and* parent** results on the same corpus, with sample count and a
  Wilson confidence bound (findings #2/#3).
- **`PromotionEnvelope`** — the controller's **ed25519-signed** decision binding
  the constitution hash, candidate hash, and receipt hashes, with a nonce and
  expiry (finding #1).
- **`verify_promotion`** — verifies signatures against **pinned per-role keys**,
  requires **≥2 distinct pinned judges**, requires the candidate to **beat its
  parent** with a **non-inferiority** margin on protected dimensions, enforces the
  constitutional gates on the **receipt-reported** numbers, rejects prohibited
  effects from the manifest, requires a **resolvable non-self rollback target**,
  and requires a **proof reference for every preserved invariant** — returning
  **every** independent violation.

Also: the constitutional change quorum now requires **distinct** signers (finding
#8); CI enforces `fmt` + `clippy -D warnings` + `cargo audit` (finding #9).

A subsequent **`deployment`** crate closes finding #6: `verified_rollback`
commands restoration through a `DeploymentAdapter`, confirms the restored
artifact hash **and** its health, and emits an ed25519-signed `RollbackReceipt`;
the runtime's canary treats a candidate as rolled-back only on a confirmed
healthy restore.

## What this closes (and what it does not)

| # | Finding | Status |
|---|---|---|
| 1 | decorative promotion signature | **Closed** — signed envelope, pinned controller key, empty rejected |
| 2 | evaluator output trusted | **Closed** — signed receipts from ≥2 pinned judges, content-bound |
| 3 | "beats parent" missing | **Closed** — receipts carry parent results; improvement + non-inferiority required |
| 4 | invariants self-asserted | **Partly closed** — proof *references* required (bare booleans rejected); independent *resolution* of the referenced artifact is the tracked next depth |
| 5 | effects caller-supplied | **Closed** — effects live inside the content-addressed manifest |
| 6 | rollback represented not executed | **Closed** — the `deployment` crate's two-phase `verified_rollback` *commands* restoration through a `DeploymentAdapter`, confirms the active artifact hash **and** health, and emits an **ed25519-signed `RollbackReceipt`**; the canary sets `rolled_back`/`slos_met` only on a confirmed healthy restore (a failed or degraded restore yields no receipt and fails the SLO) |
| 7 | rolling-window dup incidents / raw excerpt | **Open** — edge-triggering + keyed fingerprints tracked |
| 8 | duplicate-signer quorum | **Closed** — distinct signers required |
| 9 | CI below standard | **Closed** — fmt + clippy(-D) + audit |

## Verification

`crates/envelope/src/tests.rs::the_review_acceptance_test_maximally_malicious_candidate`
constructs exactly the review's adversarial candidate and asserts **≥6 distinct
`Reject` variants** (it produces ~11), plus each named failure individually. The
runtime acceptance test now runs the full loop on this closed path: an unseen
attack becomes a **signed, independently-evaluated** defense (2 distinct judges +
a verified envelope) that **beats the parent**, with a verified lineage chain and
an injected regression rolling back within the SLO. 66 tests; `cargo audit`,
`fmt --check`, and `clippy -D warnings` all clean.

## Next (per the review's phased plan)

Independent proof resolution (finding #4 fully — the referenced artifact is
required but not yet independently *re-derived*); detector-incident
edge-triggering + keyed fingerprints (finding #7 — the last open item); fold the
pinned role keys into `Constitution` itself; raise the receipt `MIN_SAMPLES`
floor toward the review's 100k for production profiles; back `DeploymentAdapter`
with a real router/orchestrator (the `InMemoryAdapter` is the deterministic
reference — the trait is the seam a production surface implements).
