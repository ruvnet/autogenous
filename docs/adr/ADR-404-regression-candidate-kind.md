# ADR-404 — Regression candidate kind for the promotion path

- Status: Accepted — Implemented
- Date: 2026-09-01
- Extends: ADR-394 (cryptographic closure of the promotion path) with a second candidate shape; changes nothing it describes.
- Related: ADR-392 (the AGL/AAP contract, typed mutations), ADR-393 (product thesis).

## Context

Every type the closed promotion path (`envelope::CandidateManifest`,
`envelope::EvaluationReceipt`, `envelope::verify_promotion`) understands is
shaped for one candidate: a binary security `Detector`, scored by
recall/false-positive-rate against a labeled corpus, with hard gates on
safety/governance/FP/p99-latency baked into `Constitution.hard_gates`
(`agl_types::HardGates`).

A downstream consumer — RuView's RuForecast, a multivariate forecasting model
trained via a Rust/Burn pipeline — needed to promote hyperparameter-tuned model
candidates scored by a continuous loss metric (weighted quantile loss, WQL)
against a held-out corpus of forecasting windows. Nothing about "beats parent
by X% recall at Y% FP" fits "beats parent by a WQL delta on a held-out split,"
and none of `HardGates`' four fields (min_safety, min_governance,
max_false_positive_rate, max_p99_overhead_ms) mean anything for a loss metric.

## Decision

Add a fully parallel module, `envelope::regression`, rather than widen the
existing types to cover both shapes (which would weaken what every existing
field means) or fork the crate. Zero changes to `CandidateManifest`,
`EvaluationReceipt`, `evaluate_and_sign`, `verify_promotion`, or any of their
7 existing tests — all pass unmodified.

New, parallel objects:

- **`RegressionCandidateManifest`** — mirrors `CandidateManifest`'s binding
  shape (mutation + payload identity + effects + capabilities + invariant
  proofs, all folded into one content hash via `candidate_hash()`), with
  `artifact_hash` (a direct SHA-256 of the candidate's raw bytes — a model
  artifact or serialized hyperparameter genome) and an explicit
  `metric_name`/`metric_direction` (`LowerIsBetter` | `HigherIsBetter`) in
  place of `detector_hash`.
- **`RegressionEvaluationReceipt`** — mirrors `EvaluationReceipt`'s
  signing/binding shape with `candidate_metric`/`parent_metric` in place of
  recall/FP. `sign_regression_receipt` binds and signs a measurement the
  caller already made; unlike `evaluate_and_sign`, it does not itself run any
  evaluation — this crate stays ignorant of what "weighted quantile loss"
  means, only that a receipt attests one number for the candidate and one for
  the parent, on the same corpus.
- **`sign_regression_promotion`** builds and signs a `PromotionEnvelope`
  (reused as-is — its fields are candidate/receipt *hashes*, not
  detector-shaped data, so it binds either candidate kind identically) without
  modifying `PromotionEnvelope::signed`, which stays typed to
  `&[EvaluationReceipt]`.
- **`verify_regression_promotion`** mirrors `verify_promotion`'s structure and
  "return every violation, not just the first" posture: envelope checks,
  receipt checks, beats-parent-by-margin (worst-case across every valid
  receipt — one failing judge is enough to reject), prohibited effects,
  resolvable non-self rollback target, and independently-re-derived invariant
  proofs (duplicating `ProofArtifact`'s private, `CandidateManifest`-typed
  `establishes` check rather than weakening its signature — the check itself
  is unchanged, just re-typed).

### Two governance constants become caller-supplied parameters, not assumed

**Judge count.** `verify_promotion` hardcodes "≥2 distinct pinned judges"
because it was designed for independent adversarial review of a security
detector. For a deterministic training/eval pipeline, running the same
evaluator twice on the same corpus produces two valid signatures over the same
number — structurally "two judges," not the independence the original
guarantee is meant to provide. Asserting a guarantee this module cannot back
would be dishonest, so `verify_regression_promotion` takes `min_judges` as a
parameter instead of hardcoding 2. A caller with only one real evaluator today
should pass `min_judges: 1` and say so in its own documentation, not pass `2`
and imply independence that doesn't exist yet. Genuine independence (distinct
held-out corpus shards, or distinct evaluator implementations) is a
caller-side responsibility no receipt-signing scheme can enforce from inside a
single signed number.

**Sample count.** `envelope::MIN_SAMPLES` (1000) reflects the detector
domain's security-review bar and has no bearing on a regression corpus's right
size. `verify_regression_promotion` takes `min_samples` as a parameter instead
of reusing that constant.

**Non-inferiority margin.** `envelope::NONINFERIORITY` (0.005) plays the same
*role* here (candidate must beat parent by at least this much, not merely
tie), but what margin is meaningful depends on the metric's own scale, which
this crate cannot know for an arbitrary future regression metric — so it is
also a parameter (`non_inferiority_margin`), not a shared constant.

## What this does not do

- **No `Constitution`/`HardGates` schema change.** The four detector-specific
  hard gates stay untouched and are not checked for regression candidates at
  all. A future generic bound (e.g. a `max_regression_metric` field) would be
  a constitutional change (≥2 signers, migration path per
  `ConstitutionChange`) — out of scope here, and not needed yet: beats-parent
  by margin is the only gate this candidate kind currently has.
- **No wiring to any real evaluator, model runtime, or deployment path.**
  This ADR closes only the promotion-path type gap. Connecting RuForecast's
  actual `evaluate` CLI output to `sign_regression_receipt`, and connecting a
  `VerifiedPromotion` to a real `DeploymentAdapter` for a live serving
  rollout, are separate, later pieces of work.
- **No new `MutationScope` variant.** A trained-model/config candidate is
  mapped onto the existing `MutationScope::ApplicationCode` (the closest
  existing risk tier for a behavior/config-level change) rather than adding a
  new scope to the shared, ordered enum — avoiding a change to a type every
  other domain also depends on for a distinction this module doesn't yet need.

## Tests

10 new tests in `envelope::regression::tests`, covering: a clean candidate
that beats its parent by more than the margin (admissible), a candidate that's
worse than its parent (rejected), a candidate that's marginally better but
inside the margin (rejected — margin is enforced, not just strict
inequality), too few pinned judges, a tampered/invalid receipt signature, a
non-finite (NaN) metric (rejected explicitly rather than silently passing a
NaN comparison), a self-pointing rollback target, the `HigherIsBetter`
direction, and that `artifact_hash` (payload bytes) and `candidate_hash()`
(whole manifest) are stable, content-sensitive, and distinct from each other.
The existing 7 `envelope::tests` cases pass unmodified — 17/17 total in the
crate.
