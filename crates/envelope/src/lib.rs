//! # envelope — the cryptographically-closed promotion path
//!
//! Built to answer the security review: promotion must depend on **independently
//! verified, content-bound evidence**, never caller-supplied booleans or strings.
//! This crate is the closed slice. Nothing here trusts a `FitnessVector` handed
//! in by a generator, an `Option<String>` "signature", or a separate
//! `declared_effects` argument.
//!
//! Three signed, content-addressed objects:
//! - [`CandidateManifest`] — the object everything binds to. **Effects,
//!   capabilities, rollback target, and invariant proofs live inside it**
//!   (findings #4/#5/#6), so its hash commits to all of them.
//! - [`EvaluationReceipt`] — a judge's **signed** measurement binding
//!   candidate *and parent* results on the same corpus, with sample count and a
//!   confidence bound (findings #2/#3).
//! - [`PromotionEnvelope`] — the controller's **signed** decision binding the
//!   constitution hash, candidate hash, and the receipt hashes, with a nonce and
//!   expiry (finding #1).
//!
//! [`verify_promotion`] verifies signatures against **pinned per-role keys**,
//! requires **≥2 distinct pinned judges**, requires the candidate to **beat its
//! parent** with a non-inferiority margin on protected dimensions, enforces the
//! constitutional gates on *receipt-reported* numbers, checks prohibited effects
//! from the manifest, requires a **resolvable non-self rollback target**, and
//! requires a **proof reference for every preserved invariant** — returning
//! *every* independent violation, not just the first.

use agl_types::{Authority, Genome, HardInvariant, Mutation, MutationScope};
use antibody::Detector;
use constitution::Constitution;
use evaluator::{replay_packaged, wilson95, Corpus};
use serde::{Deserialize, Serialize};
use witness::{content_hash, SigningAuthority};

/// Minimum evidence population a receipt must attest (the review's full bar is
/// 100k; this is the enforced floor — production pins it higher per environment).
pub const MIN_SAMPLES: usize = 1000;
/// Non-inferiority margin on protected dimensions.
pub const NONINFERIORITY: f64 = 0.005;

/// A proof reference for a preserved invariant (finding #4: no self-asserted
/// booleans — a claim must point at resolvable evidence).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvariantProof {
    pub invariant: String,
    /// e.g. `"property_test"`, `"model_check"`, `"capability_analysis"`, `"signed_measurement"`.
    pub kind: String,
    /// **Content hash of the [`ProofArtifact`]** the verifier resolves and
    /// independently re-derives (finding #4). Must equal `artifact.reference()`.
    pub reference: String,
}

/// The actual, content-addressed evidence a [`InvariantProof`] points at
/// (finding #4 — independent *resolution*, not just a reference). A
/// `capability_analysis` artifact records the exact facts the analysis examined:
/// the mutation's requested authority + scope and the parent's ceiling. The
/// verifier resolves it by content hash, confirms it examined **this exact**
/// mutation/parent (so a proof for a different candidate can't be reused), and
/// re-derives its conclusion — it never trusts the artifact's say-so.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofArtifact {
    pub invariant: String,
    pub kind: String,
    pub examined_authority: Authority,
    pub examined_scope: MutationScope,
    pub parent_ceiling: Authority,
}

impl ProofArtifact {
    /// The content hash an [`InvariantProof::reference`] must equal.
    pub fn reference(&self) -> String {
        content_hash(self)
    }

    /// Independent re-derivation: do the recorded facts (a) match the *actual*
    /// manifest + parent, and (b) *imply* the invariant is preserved? A
    /// `capability_analysis` proves preservation only when the mutation does not
    /// expand authority beyond the parent ceiling; it is not sound for scopes
    /// that themselves govern security/constitutional policy (those need a
    /// stronger proof kind the verifier does not yet resolve, so they reject).
    fn establishes(&self, invariant: &str, manifest: &CandidateManifest, parent: &Genome) -> bool {
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

/// The content-addressed candidate. Its hash commits to the mutation, the exact
/// detector bytes, the declared effects & capabilities, the rollback target, and
/// the invariant proofs — so none of them can be swapped or omitted at verify time.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CandidateManifest {
    pub mutation: Mutation,
    /// Content hash of the exact detector bytes this candidate ships.
    pub detector_hash: String,
    pub declared_effects: Vec<String>,
    pub requested_capabilities: Vec<String>,
    pub invariant_proofs: Vec<InvariantProof>,
}

impl CandidateManifest {
    pub fn from_parts(
        mutation: Mutation,
        detector: &Detector,
        effects: Vec<String>,
        caps: Vec<String>,
        proofs: Vec<InvariantProof>,
    ) -> Self {
        CandidateManifest {
            mutation,
            detector_hash: content_hash(detector),
            declared_effects: effects,
            requested_capabilities: caps,
            invariant_proofs: proofs,
        }
    }
    pub fn candidate_hash(&self) -> String {
        content_hash(self)
    }
}

/// A judge's signed evaluation receipt (finding #2/#3).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvaluationReceipt {
    pub candidate_hash: String,
    pub parent_hash: String,
    pub corpus_id: String,
    pub sample_count: usize,
    pub candidate_recall: f64,
    /// Lower bound of the candidate recall's 95% Wilson interval.
    pub candidate_recall_lo: f64,
    pub candidate_fp: f64,
    /// Upper bound of the candidate FP's 95% Wilson interval.
    pub candidate_fp_hi: f64,
    pub parent_recall: f64,
    pub parent_fp: f64,
    pub p99_overhead_ms: f64,
    pub evaluator_version: String,
    pub judge_pubkey: String,
    pub timestamp: u64,
    #[serde(default)]
    pub signature: String,
}

impl EvaluationReceipt {
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
            && witness::verify_hex(&self.judge_pubkey, &self.signing_bytes(), &self.signature)
    }
}

/// Evaluate a candidate detector AND its parent on the same corpus, and sign the
/// receipt as `judge`. This is what an authorized judge runs; the generator never
/// calls it (evaluator separation).
#[allow(clippy::too_many_arguments)]
pub fn evaluate_and_sign(
    judge: &SigningAuthority,
    candidate_hash: &str,
    parent_hash: &str,
    candidate: &Detector,
    parent: &Detector,
    corpus: &Corpus,
    corpus_id: &str,
    evaluator_version: &str,
    p99_overhead_ms: f64,
    now: u64,
) -> EvaluationReceipt {
    let c = replay_packaged(candidate, corpus);
    let p = replay_packaged(parent, corpus);
    let samples = corpus.malicious.len() + corpus.benign.len();
    let recall_ci = wilson95(c.malicious_detected, c.malicious_total);
    let fp_ci = wilson95(c.benign_flagged, c.benign_total);
    let mut r = EvaluationReceipt {
        candidate_hash: candidate_hash.to_string(),
        parent_hash: parent_hash.to_string(),
        corpus_id: corpus_id.to_string(),
        sample_count: samples,
        candidate_recall: c.recall,
        candidate_recall_lo: recall_ci.0,
        candidate_fp: c.fp_rate,
        candidate_fp_hi: fp_ci.1,
        parent_recall: p.recall,
        parent_fp: p.fp_rate,
        p99_overhead_ms,
        evaluator_version: evaluator_version.to_string(),
        judge_pubkey: judge.public_hex(),
        timestamp: now,
        signature: String::new(),
    };
    r.signature = judge.sign_hex(&r.signing_bytes());
    r
}

/// The controller's signed promotion decision (finding #1).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PromotionEnvelope {
    pub constitution_hash: String,
    pub candidate_hash: String,
    pub receipt_hashes: Vec<String>,
    pub signer_role: String,
    pub controller_pubkey: String,
    pub nonce: String,
    pub timestamp: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub signature: String,
}

impl PromotionEnvelope {
    fn signing_bytes(&self) -> Vec<u8> {
        let mut u = self.clone();
        u.signature = String::new();
        serde_json::to_vec(&u).unwrap_or_default()
    }
    pub fn verify(&self) -> bool {
        !self.signature.is_empty()
            && witness::verify_hex(
                &self.controller_pubkey,
                &self.signing_bytes(),
                &self.signature,
            )
    }
    /// Build and sign an envelope over a candidate + its receipts.
    pub fn signed(
        controller: &SigningAuthority,
        constitution_hash: &str,
        candidate_hash: &str,
        receipts: &[EvaluationReceipt],
        nonce: &str,
        now: u64,
        ttl_secs: u64,
    ) -> Self {
        let mut e = PromotionEnvelope {
            constitution_hash: constitution_hash.to_string(),
            candidate_hash: candidate_hash.to_string(),
            receipt_hashes: receipts.iter().map(EvaluationReceipt::hash).collect(),
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
}

/// Pinned per-role public keys (the constitution's key policy; folding these
/// fields into `constitution::Constitution` is the tracked follow-up).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RolePins {
    pub judges: Vec<String>,
    pub controllers: Vec<String>,
}

/// Every independent reason a promotion is refused. `verify_promotion` returns
/// all that apply, so a maximally-malicious candidate is rejected for many.
#[derive(Clone, Debug, PartialEq)]
pub enum Reject {
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
    NotBetterThanParent,
    InferiorOnProtectedDimension(String),
    GateSafety(f64),
    GateFalsePositive(f64),
    GateLatency(f64),
    ProhibitedEffect(String),
    RollbackMissingOrSelf,
    /// No proof reference for a preserved invariant (finding #4).
    InvariantUnproven(String),
    /// A proof reference that resolves to no supplied artifact (finding #4).
    ProofUnresolved(String),
    /// A resolved proof artifact whose independently-re-derived facts do not
    /// establish the invariant for this exact candidate (finding #4).
    ProofDoesNotEstablish(String),
    Inadmissible(String),
}

/// The closed check. Returns **every** violation; an empty vec means the
/// candidate is cryptographically admissible and promotable.
#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
pub fn verify_promotion(
    constitution: &Constitution,
    parent: &Genome,
    manifest: &CandidateManifest,
    receipts: &[EvaluationReceipt],
    envelope: &PromotionEnvelope,
    pins: &RolePins,
    proof_artifacts: &[ProofArtifact],
    now: u64,
) -> Vec<Reject> {
    let mut rej = Vec::new();
    let cand_hash = manifest.candidate_hash();
    let parent_hash = content_hash(&parent.hash);

    // --- envelope (finding #1) ---
    if envelope.constitution_hash != constitution.hash() {
        rej.push(Reject::ConstitutionMismatch);
    }
    if envelope.signature.is_empty() {
        rej.push(Reject::EnvelopeUnsigned);
    } else if !envelope.verify() {
        rej.push(Reject::EnvelopeBadSignature);
    }
    if now >= envelope.expires_at {
        rej.push(Reject::EnvelopeExpired);
    }
    if !pins.controllers.contains(&envelope.controller_pubkey) {
        rej.push(Reject::ControllerNotPinned);
    }
    if envelope.candidate_hash != cand_hash {
        rej.push(Reject::CandidateHashMismatch);
    }
    let want_hashes: Vec<String> = receipts.iter().map(EvaluationReceipt::hash).collect();
    if envelope.receipt_hashes != want_hashes {
        rej.push(Reject::ReceiptHashesMismatch);
    }

    // --- receipts (findings #2/#3) ---
    let mut distinct_judges = std::collections::BTreeSet::new();
    let mut valid_receipts: Vec<&EvaluationReceipt> = Vec::new();
    for r in receipts {
        if !r.verify() {
            rej.push(Reject::ReceiptBadSignature(r.judge_pubkey.clone()));
            continue;
        }
        if !pins.judges.contains(&r.judge_pubkey) {
            rej.push(Reject::JudgeNotPinned(r.judge_pubkey.clone()));
        }
        if r.candidate_hash != cand_hash {
            rej.push(Reject::ReceiptWrongCandidate(r.judge_pubkey.clone()));
        }
        if r.parent_hash != parent_hash {
            rej.push(Reject::ReceiptWrongParent(r.judge_pubkey.clone()));
        }
        if r.sample_count < MIN_SAMPLES {
            rej.push(Reject::ReceiptTooFewSamples {
                have: r.sample_count,
                need: MIN_SAMPLES,
            });
        }
        distinct_judges.insert(r.judge_pubkey.clone());
        valid_receipts.push(r);
    }
    let corpus_consistent = valid_receipts
        .windows(2)
        .all(|w| w[0].corpus_id == w[1].corpus_id);
    if !corpus_consistent {
        rej.push(Reject::ReceiptCorpusMismatch);
    }
    // count only receipts that are valid AND from pinned distinct judges
    let pinned_distinct: std::collections::BTreeSet<&String> = valid_receipts
        .iter()
        .filter(|r| pins.judges.contains(&r.judge_pubkey))
        .map(|r| &r.judge_pubkey)
        .collect();
    if pinned_distinct.len() < 2 {
        rej.push(Reject::TooFewJudges {
            have: pinned_distinct.len(),
            need: 2,
        });
    }
    if !valid_receipts.is_empty() && distinct_judges.len() < valid_receipts.len() {
        rej.push(Reject::JudgesNotDistinct);
    }

    // --- beats-parent + gates (finding #3, and gates on receipt numbers #2) ---
    if let Some(r) = valid_receipts.first() {
        let better = r.candidate_recall_lo > r.parent_recall || r.candidate_fp_hi < r.parent_fp;
        if !better {
            rej.push(Reject::NotBetterThanParent);
        }
        // non-inferiority on protected dims
        if r.candidate_fp_hi > r.parent_fp + NONINFERIORITY {
            rej.push(Reject::InferiorOnProtectedDimension(
                "false_positive_rate".into(),
            ));
        }
        if r.candidate_recall_lo < r.parent_recall - NONINFERIORITY {
            rej.push(Reject::InferiorOnProtectedDimension("recall".into()));
        }
        // constitutional hard gates on the MEASURED numbers
        let g = &constitution.hard_gates;
        if r.candidate_recall < g.min_safety {
            rej.push(Reject::GateSafety(r.candidate_recall));
        }
        if r.candidate_fp_hi > g.max_false_positive_rate {
            rej.push(Reject::GateFalsePositive(r.candidate_fp_hi));
        }
        if r.p99_overhead_ms > g.max_p99_overhead_ms {
            rej.push(Reject::GateLatency(r.p99_overhead_ms));
        }
    }

    // --- effects from the manifest (finding #5) ---
    for e in &manifest.declared_effects {
        if constitution.prohibits(e) {
            rej.push(Reject::ProhibitedEffect(e.clone()));
        }
    }

    // --- rollback: resolvable, non-self target (finding #6 partial) ---
    match &manifest.mutation.rollback_target {
        Some(t) if *t == parent.hash && *t != cand_hash => {}
        _ => rej.push(Reject::RollbackMissingOrSelf),
    }

    // --- invariants: resolve + INDEPENDENTLY re-derive each proof (finding #4) ---
    for inv in &parent.hard_invariants {
        if !inv.holds {
            continue;
        }
        // 1. A proof reference must exist for the invariant.
        let proof = manifest
            .invariant_proofs
            .iter()
            .find(|p| p.invariant == inv.name && !p.reference.trim().is_empty());
        let Some(proof) = proof else {
            rej.push(Reject::InvariantUnproven(inv.name.clone()));
            continue;
        };
        // 2. Resolve the referenced artifact by content hash (content-addressed —
        //    a reference that points at nothing, or at a swapped artifact, fails).
        let artifact = proof_artifacts
            .iter()
            .find(|a| a.reference() == proof.reference);
        let Some(artifact) = artifact else {
            rej.push(Reject::ProofUnresolved(inv.name.clone()));
            continue;
        };
        // 3. Independently re-derive that it establishes THIS candidate's invariant.
        if !artifact.establishes(&inv.name, manifest, parent) {
            rej.push(Reject::ProofDoesNotEstablish(inv.name.clone()));
        }
    }

    // --- typed admissibility (authority monotonicity, expiry, scope) ---
    // Populate preserved_invariants from the PROVEN set so the base check aligns.
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
        rej.push(Reject::Inadmissible(format!("{e:?}")));
    }

    rej
}

#[cfg(test)]
mod tests;
