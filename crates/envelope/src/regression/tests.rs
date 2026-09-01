//! Positive closure + a few adversarial paths for the regression promotion path,
//! mirroring `envelope::tests`'s style but for `RegressionCandidateManifest`.

use super::*;
use agl_types::{Applicability, Authority, Genome, HardGates, MutationScope};
use constitution::{Constitution, RoleKeys};
use witness::SigningAuthority;

const NOW: u64 = 1_800_000_000;

fn pinned_keys() -> RoleKeys {
    let j1 = SigningAuthority::from_seed("judge-1", [1u8; 32]);
    let j2 = SigningAuthority::from_seed("judge-2", [2u8; 32]);
    let ctrl = SigningAuthority::from_seed("controller", [3u8; 32]);
    RoleKeys {
        judges: vec![j1.public_hex(), j2.public_hex()],
        controllers: vec![ctrl.public_hex()],
    }
}

fn constitution() -> Constitution {
    Constitution {
        identity: "ruforecast-closed".into(),
        version: 1,
        authority_ceiling: Authority::Governed,
        prohibited_effects: vec!["pii_egress".into()],
        hard_gates: HardGates::default(),
        signers: vec!["a".into(), "b".into()],
        pinned_keys: pinned_keys(),
        effective_at: 1_700_000_000,
    }
}

fn parent(c: &Constitution) -> Genome {
    Genome {
        hash: "genome-parent".into(),
        identity: "ruforecast".into(),
        constitution: c.hash(),
        capability_ceiling: Authority::Governed,
        hard_invariants: vec![],
        lineage: vec![],
    }
}

fn mutation(parent_hash: &str, rollback: Option<String>) -> Mutation {
    Mutation {
        id: "mut-regression-1".into(),
        parent_genome_hash: parent_hash.into(),
        scope: MutationScope::ApplicationCode,
        requested_authority: Authority::Governed,
        applicability: Applicability::default(),
        preserved_invariants: vec![],
        rollback_target: rollback,
        expires_at: Some(NOW + 3600),
        signature: None,
    }
}

fn manifest(p: &Genome, candidate_bytes: &[u8]) -> RegressionCandidateManifest {
    RegressionCandidateManifest::from_parts(
        mutation(&p.hash, Some(p.hash.clone())),
        candidate_bytes,
        "weighted_quantile_loss",
        MetricDirection::LowerIsBetter,
        vec![],
        vec![],
        vec![],
    )
}

fn sign_closure(
    p: &Genome,
    m: &RegressionCandidateManifest,
    candidate_metric: f64,
    parent_metric: f64,
) -> (Vec<RegressionEvaluationReceipt>, PromotionEnvelope) {
    let cand_hash = m.candidate_hash();
    let parent_hash = content_hash(&p.hash);
    let j1 = SigningAuthority::from_seed("judge-1", [1u8; 32]);
    let j2 = SigningAuthority::from_seed("judge-2", [2u8; 32]);
    let ctrl = SigningAuthority::from_seed("controller", [3u8; 32]);
    let r1 = sign_regression_receipt(
        &j1,
        &cand_hash,
        &parent_hash,
        "corpus-v1",
        24,
        candidate_metric,
        parent_metric,
        "ruforecast-eval-1",
        NOW,
    );
    let r2 = sign_regression_receipt(
        &j2,
        &cand_hash,
        &parent_hash,
        "corpus-v1",
        24,
        candidate_metric,
        parent_metric,
        "ruforecast-eval-1",
        NOW,
    );
    let receipts = vec![r1, r2];
    let envelope = sign_regression_promotion(
        &ctrl,
        &constitution().hash(),
        &cand_hash,
        &receipts,
        "nonce-1",
        NOW,
        3600,
    );
    (receipts, envelope)
}

#[test]
fn clean_candidate_that_beats_parent_is_admissible() {
    let c = constitution();
    let p = parent(&c);
    let m = manifest(&p, b"candidate-model-bytes-v1");
    // WQL 0.153 beats parent WQL 0.257 by well over any reasonable margin.
    let (receipts, envelope) = sign_closure(&p, &m, 0.153, 0.257);
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert_eq!(rej, Vec::<RegressionReject>::new());
}

#[test]
fn distinct_corpus_ids_across_judges_are_accepted() {
    // Independent-corpus judging (each judge scores the SAME candidate/parent
    // pair against its OWN held-out corpus) is the intentional design for
    // this regression candidate kind -- see the post-review correction note
    // on `verify_regression_promotion`'s (removed) corpus-consistency check.
    // A clean candidate must still be admissible when its judges' receipts
    // carry genuinely different `corpus_id`s.
    let c = constitution();
    let p = parent(&c);
    let m = manifest(&p, b"candidate-model-bytes-distinct-corpora");
    let cand_hash = m.candidate_hash();
    let parent_hash = content_hash(&p.hash);
    let j1 = SigningAuthority::from_seed("judge-1", [1u8; 32]);
    let j2 = SigningAuthority::from_seed("judge-2", [2u8; 32]);
    let ctrl = SigningAuthority::from_seed("controller", [3u8; 32]);
    // Both judges independently see the candidate beat the parent, but on
    // two different synthetic corpora (as the RuForecast bridge does with
    // distinct `--seed`s per judge).
    let r1 = sign_regression_receipt(
        &j1,
        &cand_hash,
        &parent_hash,
        "ruforecast-synthetic-seed-1000",
        24,
        0.153,
        0.257,
        "ruforecast-eval-1",
        NOW,
    );
    let r2 = sign_regression_receipt(
        &j2,
        &cand_hash,
        &parent_hash,
        "ruforecast-synthetic-seed-1097",
        24,
        0.140,
        0.240,
        "ruforecast-eval-1",
        NOW,
    );
    let receipts = vec![r1, r2];
    let envelope = sign_regression_promotion(
        &ctrl,
        &c.hash(),
        &cand_hash,
        &receipts,
        "nonce-distinct-corpora",
        NOW,
        3600,
    );
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert_eq!(rej, Vec::<RegressionReject>::new());
}

#[test]
fn candidate_not_better_than_parent_is_rejected() {
    let c = constitution();
    let p = parent(&c);
    let m = manifest(&p, b"candidate-model-bytes-v2");
    // Candidate WQL 0.30 is WORSE than parent WQL 0.257 (lower is better).
    let (receipts, envelope) = sign_closure(&p, &m, 0.30, 0.257);
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert!(rej
        .iter()
        .any(|r| matches!(r, RegressionReject::NotBetterThanParent { .. })));
}

#[test]
fn margin_is_enforced_not_just_strictly_less() {
    let c = constitution();
    let p = parent(&c);
    let m = manifest(&p, b"candidate-model-bytes-v3");
    // Candidate WQL 0.2565 is technically lower than parent 0.257 but the gap
    // (0.0005) is smaller than the 0.005 non-inferiority margin required.
    let (receipts, envelope) = sign_closure(&p, &m, 0.2565, 0.257);
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert!(rej
        .iter()
        .any(|r| matches!(r, RegressionReject::NotBetterThanParent { .. })));
}

#[test]
fn too_few_judges_is_rejected() {
    let c = constitution();
    let p = parent(&c);
    let m = manifest(&p, b"candidate-model-bytes-v4");
    let (receipts, envelope) = sign_closure(&p, &m, 0.153, 0.257);
    // Ask for 3 pinned judges when the constitution only pins 2.
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 3, 1, 0.005, NOW);
    assert!(rej
        .iter()
        .any(|r| matches!(r, RegressionReject::TooFewJudges { need: 3, .. })));
}

#[test]
fn tampered_receipt_signature_is_rejected() {
    let c = constitution();
    let p = parent(&c);
    let m = manifest(&p, b"candidate-model-bytes-v5");
    let (mut receipts, envelope) = sign_closure(&p, &m, 0.153, 0.257);
    receipts[0].candidate_metric = 0.0; // mutate after signing -> signature no longer covers this value
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert!(rej
        .iter()
        .any(|r| matches!(r, RegressionReject::ReceiptBadSignature(_))));
}

#[test]
fn non_finite_metric_is_rejected_not_silently_accepted() {
    let c = constitution();
    let p = parent(&c);
    let m = manifest(&p, b"candidate-model-bytes-v6");
    let cand_hash = m.candidate_hash();
    let parent_hash = content_hash(&p.hash);
    let j1 = SigningAuthority::from_seed("judge-1", [1u8; 32]);
    let j2 = SigningAuthority::from_seed("judge-2", [2u8; 32]);
    let ctrl = SigningAuthority::from_seed("controller", [3u8; 32]);
    // A properly-signed receipt whose candidate_metric is NaN (e.g. a training
    // run that diverged) must still be caught, not treated as "beats parent"
    // by an accidental NaN comparison always being false-so-passing.
    let r1 = sign_regression_receipt(
        &j1,
        &cand_hash,
        &parent_hash,
        "corpus-v1",
        24,
        f64::NAN,
        0.257,
        "ruforecast-eval-1",
        NOW,
    );
    let r2 = sign_regression_receipt(
        &j2,
        &cand_hash,
        &parent_hash,
        "corpus-v1",
        24,
        0.153,
        0.257,
        "ruforecast-eval-1",
        NOW,
    );
    let receipts = vec![r1, r2];
    let envelope = sign_regression_promotion(
        &ctrl,
        &c.hash(),
        &cand_hash,
        &receipts,
        "nonce-1",
        NOW,
        3600,
    );
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert!(rej
        .iter()
        .any(|r| matches!(r, RegressionReject::ReceiptMetricNotFinite(_))));
}

#[test]
fn self_rollback_target_is_rejected() {
    let c = constitution();
    let p = parent(&c);
    // rollback_target points at itself once hashed, not at the parent.
    let bad_mutation = mutation(&p.hash, Some("not-the-parent-hash".into()));
    let m = RegressionCandidateManifest::from_parts(
        bad_mutation,
        b"candidate-model-bytes-v7",
        "weighted_quantile_loss",
        MetricDirection::LowerIsBetter,
        vec![],
        vec![],
        vec![],
    );
    let (receipts, envelope) = sign_closure(&p, &m, 0.153, 0.257);
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert!(rej.contains(&RegressionReject::RollbackMissingOrSelf));
}

#[test]
fn higher_is_better_direction_is_honored() {
    let c = constitution();
    let p = parent(&c);
    let mut m = manifest(&p, b"candidate-model-bytes-v8");
    m.metric_direction = MetricDirection::HigherIsBetter;
    m.metric_name = "interval_coverage".into();
    // 0.82 beats parent 0.75 when higher is better.
    let (receipts, envelope) = sign_closure(&p, &m, 0.82, 0.75);
    let rej = verify_regression_promotion(&c, &p, &m, &receipts, &envelope, &[], 2, 1, 0.005, NOW);
    assert_eq!(rej, Vec::<RegressionReject>::new());
}

#[test]
fn artifact_hash_is_stable_and_content_sensitive() {
    let h1 = artifact_hash(b"same bytes");
    let h2 = artifact_hash(b"same bytes");
    let h3 = artifact_hash(b"different bytes");
    assert_eq!(h1, h2);
    assert_ne!(h1, h3);
}

#[test]
fn candidate_hash_differs_from_artifact_hash() {
    let p = parent(&constitution());
    let m = manifest(&p, b"candidate-model-bytes-v9");
    // The manifest hash (candidate_hash) must not equal the raw payload hash
    // (artifact_hash) — they're different content addresses over different
    // bytes (whole manifest vs. payload only).
    assert_ne!(m.candidate_hash(), m.artifact_hash);
}
