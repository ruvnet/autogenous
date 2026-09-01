//! # regression — a parallel promotion path for continuous-metric candidates
//!
//! [`crate`] (envelope) was built for one candidate shape: a binary security
//! `Detector` scored by recall/false-positive-rate against a labeled corpus.
//! Not every candidate this runtime might promote fits that shape — a trained
//! forecasting model, scored by a continuous loss metric (e.g. weighted
//! quantile loss) against a held-out corpus, is a different shape with a
//! different "better than parent" test and no meaningful recall/FP/latency
//! hard gates. Rather than stretch [`crate::CandidateManifest`]/
//! [`crate::EvaluationReceipt`]/[`crate::verify_promotion`] to cover both
//! (weakening what each field actually means), this module adds a **fully
//! parallel** candidate/receipt/verify path for continuous metrics. Nothing
//! in the parent module changes; every existing type, constant, and function
//! keeps its exact prior behavior.
//!
//! Reused as-is (genuinely domain-agnostic, so duplicating them would only
//! add drift risk): [`witness::content_hash`], [`witness::SigningAuthority`],
//! [`witness::verify_hex`], [`agl_types::Mutation`]/[`agl_types::Genome`]
//! (a mutation's authority/scope/rollback/admissibility rules don't care what
//! the payload is), [`crate::InvariantProof`]/[`crate::ProofArtifact`], and
//! [`crate::PromotionEnvelope`] (its fields are candidate/receipt *hashes*,
//! not detector-shaped data, so it binds a regression candidate's evidence
//! exactly as well as a detector's — see [`sign_regression_promotion`], which
//! builds one without touching [`crate::PromotionEnvelope::signed`]).
//!
//! **Judge-count honesty.** The parent path hardcodes "≥2 distinct pinned
//! judges" because it was designed for independent adversarial review of a
//! security detector. For a deterministic training/eval pipeline, running the
//! same evaluator twice on the same corpus produces two signatures over the
//! same number — structurally "two judges" but not the independence the
//! original guarantee means to provide. Rather than assert a guarantee this
//! module cannot back, [`verify_regression_promotion`] takes `min_judges` as
//! a caller-supplied parameter instead of a hardcoded 2. A caller with only
//! one real evaluator today should pass `min_judges: 1` and say so, not pass
//! `2` and imply independence that doesn't exist yet. Genuine independence
//! (distinct held-out corpus shards, or distinct evaluator implementations)
//! is a caller-side (Phase B) responsibility this type cannot enforce from
//! inside a single receipt.
//!
//! **No detector hard gates.** [`agl_types::HardGates`] (min_safety,
//! min_governance, max_false_positive_rate, max_p99_overhead_ms) is part of
//! the externally-governed [`Constitution`] and is left untouched — extending
//! it would be a constitutional change (≥2 signers, migration path), out of
//! scope here. A regression candidate is judged only on beating its parent by
//! at least `non_inferiority_margin` on its declared metric, in its declared
//! direction. A future generic bound (e.g. `max_regression_metric`) could be
//! added to `Constitution` later, through the normal constitutional-change
//! process, if a caller needs one.
//!
//! **Sample-count floor.** [`crate::MIN_SAMPLES`] (1000) reflects the
//! detector domain's review bar and has no bearing on a regression corpus's
//! right size. This module takes `min_samples` as a parameter instead of
//! reusing that constant, so a caller can state an honest floor for its own
//! corpus rather than being silently held to an unrelated threshold.

use agl_types::{Genome, HardInvariant, Mutation, MutationScope};
use constitution::Constitution;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use witness::{content_hash, verify_hex, SigningAuthority};

use crate::{InvariantProof, PromotionEnvelope, ProofArtifact};

/// Which direction makes a regression metric "better". Weighted quantile loss
/// is lower-is-better; kept as an explicit choice rather than assumed so a
/// future higher-is-better metric (e.g. an accuracy or coverage score) fits
/// the same types without a new candidate kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricDirection {
    LowerIsBetter,
    HigherIsBetter,
}

/// SHA-256 over raw candidate artifact bytes (a trained model artifact or a
/// serialized hyperparameter genome), hex-encoded. Deliberately *not*
/// [`witness::content_hash`] (which hashes the canonical JSON encoding of a
/// `Serialize` value): the candidate here already IS a byte payload — model
/// artifact bytes, or a genome file's bytes — and hashing those bytes
/// directly is the honest content address, with no serialization step that
/// could silently diverge from what was actually evaluated.
pub fn artifact_hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The content-addressed regression candidate. Mirrors
/// [`crate::CandidateManifest`]'s binding shape (mutation + payload identity +
/// effects + capabilities + invariant proofs, all folded into one hash) with
/// `artifact_hash`/`metric_name`/`metric_direction` in place of `detector_hash`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegressionCandidateManifest {
    pub mutation: Mutation,
    /// [`artifact_hash`] of the exact candidate bytes this manifest is about.
    pub artifact_hash: String,
    /// Name of the metric a receipt measures for this candidate, e.g.
    /// `"weighted_quantile_loss"`. Free text by design — this crate does not
    /// need to know what the metric means, only that every receipt against
    /// this candidate reports the same one (checked by the caller providing
    /// consistent receipts; not independently re-derivable from bytes here).
    pub metric_name: String,
    pub metric_direction: MetricDirection,
    pub declared_effects: Vec<String>,
    pub requested_capabilities: Vec<String>,
    pub invariant_proofs: Vec<InvariantProof>,
}

impl RegressionCandidateManifest {
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        mutation: Mutation,
        candidate_bytes: &[u8],
        metric_name: impl Into<String>,
        metric_direction: MetricDirection,
        effects: Vec<String>,
        caps: Vec<String>,
        proofs: Vec<InvariantProof>,
    ) -> Self {
        RegressionCandidateManifest {
            mutation,
            artifact_hash: artifact_hash(candidate_bytes),
            metric_name: metric_name.into(),
            metric_direction,
            declared_effects: effects,
            requested_capabilities: caps,
            invariant_proofs: proofs,
        }
    }

    /// Content hash of the whole manifest — what receipts/envelopes bind to.
    /// Named to match [`crate::CandidateManifest::candidate_hash`]; distinct
    /// from the `artifact_hash` field, which hashes only the payload bytes.
    pub fn candidate_hash(&self) -> String {
        content_hash(self)
    }
}

/// A judge's signed measurement of a regression candidate against its parent
/// on the same corpus. Mirrors [`crate::EvaluationReceipt`]'s signing/binding
/// shape with `candidate_metric`/`parent_metric` in place of recall/FP.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegressionEvaluationReceipt {
    pub candidate_hash: String,
    pub parent_hash: String,
    pub corpus_id: String,
    pub sample_count: usize,
    pub candidate_metric: f64,
    pub parent_metric: f64,
    pub evaluator_version: String,
    pub judge_pubkey: String,
    pub timestamp: u64,
    #[serde(default)]
    pub signature: String,
}

impl RegressionEvaluationReceipt {
    fn signing_bytes(&self) -> Vec<u8> {
        let mut u = self.clone();
        u.signature = String::new();
        serde_json::to_vec(&u).unwrap_or_default()
    }
    pub fn hash(&self) -> String {
        content_hash(self)
    }
    pub fn verify(&self) -> bool {
        !self.signature.is_empty()
            && verify_hex(&self.judge_pubkey, &self.signing_bytes(), &self.signature)
    }
}

/// Build and sign a regression evaluation receipt as `judge`. The caller has
/// already computed `candidate_metric`/`parent_metric` (e.g. by running
/// RuForecast's `evaluate` CLI) — unlike [`crate::evaluate_and_sign`], this
/// function does not itself run any evaluation; it only binds and signs
/// results the caller measured. That split keeps this crate ignorant of what
/// "weighted quantile loss" means, matching the module doc's scope.
#[allow(clippy::too_many_arguments)]
pub fn sign_regression_receipt(
    judge: &SigningAuthority,
    candidate_hash: &str,
    parent_hash: &str,
    corpus_id: &str,
    sample_count: usize,
    candidate_metric: f64,
    parent_metric: f64,
    evaluator_version: &str,
    now: u64,
) -> RegressionEvaluationReceipt {
    let mut r = RegressionEvaluationReceipt {
        candidate_hash: candidate_hash.to_string(),
        parent_hash: parent_hash.to_string(),
        corpus_id: corpus_id.to_string(),
        sample_count,
        candidate_metric,
        parent_metric,
        evaluator_version: evaluator_version.to_string(),
        judge_pubkey: judge.public_hex(),
        timestamp: now,
        signature: String::new(),
    };
    r.signature = judge.sign_hex(&r.signing_bytes());
    r
}

/// Build and sign a [`PromotionEnvelope`] over a regression candidate and its
/// receipts, without touching [`PromotionEnvelope::signed`] (which is typed
/// to `&[crate::EvaluationReceipt]`). `PromotionEnvelope`'s own fields are
/// already candidate/receipt *hashes*, so it binds either candidate shape
/// identically; this just constructs it with `RegressionEvaluationReceipt`
/// hashes instead.
pub fn sign_regression_promotion(
    controller: &SigningAuthority,
    constitution_hash: &str,
    candidate_hash: &str,
    receipts: &[RegressionEvaluationReceipt],
    nonce: &str,
    now: u64,
    ttl_secs: u64,
) -> PromotionEnvelope {
    let mut e = PromotionEnvelope {
        constitution_hash: constitution_hash.to_string(),
        candidate_hash: candidate_hash.to_string(),
        receipt_hashes: receipts
            .iter()
            .map(RegressionEvaluationReceipt::hash)
            .collect(),
        signer_role: "controller".into(),
        controller_pubkey: controller.public_hex(),
        nonce: nonce.to_string(),
        timestamp: now,
        expires_at: now.saturating_add(ttl_secs),
        signature: String::new(),
    };
    e.signature = controller.sign_hex(&e.signing_bytes());
    e
}

/// Every independent reason a regression promotion is refused. Mirrors
/// [`crate::Reject`]'s "return every violation, not just the first" shape,
/// with the detector-specific gate variants replaced by
/// [`RegressionReject::NotBetterThanParent`] and the constants that were
/// hardcoded in the parent path (`MIN_SAMPLES`, judge count 2) turned into
/// this function's parameters instead of assumed values.
#[derive(Clone, Debug, PartialEq)]
pub enum RegressionReject {
    ConstitutionMismatch,
    EnvelopeUnsigned,
    EnvelopeBadSignature,
    EnvelopeExpired,
    ControllerNotPinned,
    CandidateHashMismatch,
    ReceiptHashesMismatch,
    TooFewJudges {
        have: usize,
        need: usize,
    },
    JudgesNotDistinct,
    JudgeNotPinned(String),
    ReceiptBadSignature(String),
    ReceiptWrongCandidate(String),
    ReceiptWrongParent(String),
    ReceiptCorpusMismatch,
    ReceiptTooFewSamples {
        have: usize,
        need: usize,
    },
    ReceiptMetricNotFinite(String),
    /// The candidate did not beat its parent by at least the non-inferiority
    /// margin, in its declared direction, for at least one valid receipt.
    NotBetterThanParent {
        judge: String,
        margin: f64,
    },
    ProhibitedEffect(String),
    RollbackMissingOrSelf,
    InvariantUnproven(String),
    ProofUnresolved(String),
    ProofDoesNotEstablish(String),
    Inadmissible(String),
}

/// The closed check for a regression candidate — the parallel of
/// [`crate::verify_promotion`]. Returns **every** violation; an empty vec
/// means the candidate is cryptographically admissible and promotable.
///
/// `min_judges` and `min_samples` are caller-supplied (see the module docs'
/// judge-count and sample-count honesty notes) rather than the parent path's
/// hardcoded 2 / [`crate::MIN_SAMPLES`]. `non_inferiority_margin` plays the
/// same role as [`crate::NONINFERIORITY`] but is also a parameter: what
/// margin is meaningful depends on the metric's own scale, which this crate
/// cannot know for an arbitrary regression metric.
#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
pub fn verify_regression_promotion(
    constitution: &Constitution,
    parent: &Genome,
    manifest: &RegressionCandidateManifest,
    receipts: &[RegressionEvaluationReceipt],
    envelope: &PromotionEnvelope,
    proof_artifacts: &[ProofArtifact],
    min_judges: usize,
    min_samples: usize,
    non_inferiority_margin: f64,
    now: u64,
) -> Vec<RegressionReject> {
    let mut rej = Vec::new();
    let cand_hash = manifest.candidate_hash();
    let parent_hash = content_hash(&parent.hash);

    // --- envelope ---
    if envelope.constitution_hash != constitution.hash() {
        rej.push(RegressionReject::ConstitutionMismatch);
    }
    if envelope.signature.is_empty() {
        rej.push(RegressionReject::EnvelopeUnsigned);
    } else if !envelope.verify() {
        rej.push(RegressionReject::EnvelopeBadSignature);
    }
    if now >= envelope.expires_at {
        rej.push(RegressionReject::EnvelopeExpired);
    }
    if !constitution
        .pinned_controllers()
        .contains(&envelope.controller_pubkey)
    {
        rej.push(RegressionReject::ControllerNotPinned);
    }
    if envelope.candidate_hash != cand_hash {
        rej.push(RegressionReject::CandidateHashMismatch);
    }
    let want_hashes: Vec<String> = receipts
        .iter()
        .map(RegressionEvaluationReceipt::hash)
        .collect();
    if envelope.receipt_hashes != want_hashes {
        rej.push(RegressionReject::ReceiptHashesMismatch);
    }

    // --- receipts ---
    let mut distinct_judges = std::collections::BTreeSet::new();
    let mut valid_receipts: Vec<&RegressionEvaluationReceipt> = Vec::new();
    for r in receipts {
        if !r.verify() {
            rej.push(RegressionReject::ReceiptBadSignature(
                r.judge_pubkey.clone(),
            ));
            continue;
        }
        if !constitution.pinned_judges().contains(&r.judge_pubkey) {
            rej.push(RegressionReject::JudgeNotPinned(r.judge_pubkey.clone()));
        }
        if r.candidate_hash != cand_hash {
            rej.push(RegressionReject::ReceiptWrongCandidate(
                r.judge_pubkey.clone(),
            ));
        }
        if r.parent_hash != parent_hash {
            rej.push(RegressionReject::ReceiptWrongParent(r.judge_pubkey.clone()));
        }
        if r.sample_count < min_samples {
            rej.push(RegressionReject::ReceiptTooFewSamples {
                have: r.sample_count,
                need: min_samples,
            });
        }
        if !r.candidate_metric.is_finite() || !r.parent_metric.is_finite() {
            rej.push(RegressionReject::ReceiptMetricNotFinite(
                r.judge_pubkey.clone(),
            ));
        }
        distinct_judges.insert(r.judge_pubkey.clone());
        valid_receipts.push(r);
    }
    // NOTE (post-review correction): independent-corpus judging is a
    // first-class, intentionally supported design for this regression
    // candidate kind -- distinct judges are expected to evaluate distinct
    // held-out corpora so that judge disagreement is a real signal, not an
    // artifact of re-scoring identical evidence (see this module's top doc
    // and the RuForecast bridge that consumes it). A same-corpus-across-
    // judges requirement, inherited unreviewed from the detector domain's
    // "multiple reviewers, same evidence" model, would reject exactly the
    // cross-corpus verification this kind exists to do. `ReceiptCorpusMismatch`
    // is kept in `RegressionReject` for API/wire compatibility with anything
    // already matching on it, but is never produced by this function.
    let pinned_distinct: std::collections::BTreeSet<&String> = valid_receipts
        .iter()
        .filter(|r| constitution.pinned_judges().contains(&r.judge_pubkey))
        .map(|r| &r.judge_pubkey)
        .collect();
    if pinned_distinct.len() < min_judges {
        rej.push(RegressionReject::TooFewJudges {
            have: pinned_distinct.len(),
            need: min_judges,
        });
    }
    if !valid_receipts.is_empty() && distinct_judges.len() < valid_receipts.len() {
        rej.push(RegressionReject::JudgesNotDistinct);
    }

    // --- beats-parent (worst-case across every pinned judge, same posture as
    //     the detector path: one failing judge is enough to reject) ---
    for r in &valid_receipts {
        if !r.candidate_metric.is_finite() || !r.parent_metric.is_finite() {
            continue; // already rejected above; don't also report NotBetterThanParent
        }
        let better = match manifest.metric_direction {
            MetricDirection::LowerIsBetter => {
                r.candidate_metric <= r.parent_metric - non_inferiority_margin
            }
            MetricDirection::HigherIsBetter => {
                r.candidate_metric >= r.parent_metric + non_inferiority_margin
            }
        };
        if !better {
            rej.push(RegressionReject::NotBetterThanParent {
                judge: r.judge_pubkey.clone(),
                margin: non_inferiority_margin,
            });
        }
    }

    // --- effects from the manifest ---
    for e in &manifest.declared_effects {
        if constitution.prohibits(e) {
            rej.push(RegressionReject::ProhibitedEffect(e.clone()));
        }
    }

    // --- rollback: resolvable, non-self target ---
    match &manifest.mutation.rollback_target {
        Some(t) if *t == parent.hash && *t != cand_hash => {}
        _ => rej.push(RegressionReject::RollbackMissingOrSelf),
    }

    // --- invariants: resolve + independently re-derive each proof ---
    for inv in &parent.hard_invariants {
        if !inv.holds {
            continue;
        }
        let proof = manifest
            .invariant_proofs
            .iter()
            .find(|p| p.invariant == inv.name && !p.reference.trim().is_empty());
        let Some(proof) = proof else {
            rej.push(RegressionReject::InvariantUnproven(inv.name.clone()));
            continue;
        };
        let artifact = proof_artifacts
            .iter()
            .find(|a| a.reference() == proof.reference);
        let Some(artifact) = artifact else {
            rej.push(RegressionReject::ProofUnresolved(inv.name.clone()));
            continue;
        };
        if !artifact.establishes_for_regression(&inv.name, manifest, parent) {
            rej.push(RegressionReject::ProofDoesNotEstablish(inv.name.clone()));
        }
    }

    // --- typed admissibility (authority monotonicity, expiry, scope) ---
    let mut m = manifest.mutation.clone();
    m.preserved_invariants = manifest
        .invariant_proofs
        .iter()
        .map(|p| HardInvariant {
            name: p.invariant.clone(),
            holds: true,
        })
        .collect();
    if let Err(e) = m.admissible(parent, now) {
        rej.push(RegressionReject::Inadmissible(format!("{e:?}")));
    }

    rej
}

/// [`ProofArtifact`]'s private `establishes` method is hard-typed to
/// `&crate::CandidateManifest`, so it cannot be called with a
/// `&RegressionCandidateManifest` even though it's visible to this
/// (descendant) module — the check only ever reads `manifest.mutation`,
/// common to both manifest shapes, but the parameter type itself doesn't
/// match. This duplicates that exact logic (capability_analysis only,
/// authority within ceiling, scope not Security/Constitutional) rather than
/// weakening the original's signature to accept both.
trait EstablishesForRegression {
    fn establishes_for_regression(
        &self,
        invariant: &str,
        manifest: &RegressionCandidateManifest,
        parent: &Genome,
    ) -> bool;
}
impl EstablishesForRegression for ProofArtifact {
    fn establishes_for_regression(
        &self,
        invariant: &str,
        manifest: &RegressionCandidateManifest,
        parent: &Genome,
    ) -> bool {
        self.kind == "capability_analysis"
            && self.invariant == invariant
            && self.examined_authority == manifest.mutation.requested_authority
            && self.examined_scope == manifest.mutation.scope
            && self.parent_ceiling == parent.capability_ceiling
            && self.examined_authority <= self.parent_ceiling
            && self.examined_scope != MutationScope::SecurityPolicy
            && self.examined_scope != MutationScope::Constitutional
    }
}

#[cfg(test)]
mod tests;
