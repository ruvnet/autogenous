//! autogenous-service — the Autogenous control-plane as a deployed HTTP service.
//!
//! Exposes the AGL admission contract (autogenous ADR-392 §6) and the fitness
//! hard-gate (§10) over an OpenAI-family-style `/v1` API, so governed agents
//! (e.g. the Cognitum Slack agent) can obtain an **independent** admission
//! verdict from a service rather than only a vendored local copy — the
//! separation ADR-392 §11 calls for (the verifier is not the generator).
//!
//! Routes:
//!   GET  /health | /status        → liveness + planes + version (PUBLIC).
//!                                    (`/healthz` is Cloud-Run-reserved at the
//!                                    edge; use `/health`.)
//!   POST /v1/agl/admit            → { mutation, parent, now } → admission verdict
//!   POST /v1/agl/fitness          → { fitness, gates? } → hard-gate verdict
//!
//! Admission is pure and deterministic (`now` is supplied), so the same inputs
//! always yield the same verdict — independently re-runnable per ADR-392 §3.4.

use agl_types::{FitnessVector, Genome, HardGates, Mutation};
use axum::{
    routing::{get, post},
    Json, Router,
};
use antibody::Detector;
use constitution::Constitution;
use envelope::{
    evaluate_and_sign, verify_promotion_artifact, CandidateManifest, EvaluationReceipt,
    ProofArtifact, PromotionEnvelope,
};
use evaluator::Corpus;
use promotion::{CanaryController, CanaryState, Decision};
use serde::{Deserialize, Serialize};
use witness::{content_hash, SigningAuthority};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    /// The five Autogenous planes (ADR-392 §4) this surface serves.
    planes: [&'static str; 5],
    /// The contract this service enforces.
    contract: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        service: "autogenous",
        version: VERSION,
        planes: [
            "constitutional",
            "morphogenetic",
            "simulation",
            "execution",
            "evidence",
        ],
        contract: "AGL admission (ADR-392 §6) + fitness hard-gate (§10)",
    })
}

#[derive(Deserialize)]
struct AdmitRequest {
    mutation: Mutation,
    parent: Genome,
    /// Unix seconds — supplied so the verdict is deterministic/reproducible.
    now: u64,
}

#[derive(Serialize)]
struct AdmitResponse {
    admitted: bool,
    /// Present only when refused: the machine name of the first violated rule.
    error: Option<String>,
    /// Present only when refused: a human-readable reason.
    reason: Option<String>,
}

/// The core governance endpoint: run AGL admission on a typed mutation.
async fn agl_admit(Json(req): Json<AdmitRequest>) -> Json<AdmitResponse> {
    match req.mutation.admissible(&req.parent, req.now) {
        Ok(()) => Json(AdmitResponse {
            admitted: true,
            error: None,
            reason: None,
        }),
        Err(e) => {
            // The upstream `AdmissionError` is `Debug` only; derive a short
            // machine code (the variant name) + a full human reason from it.
            let full = format!("{e:?}");
            let code = full
                .split(|c: char| c == ' ' || c == '(' || c == '{')
                .next()
                .unwrap_or("Error")
                .to_string();
            Json(AdmitResponse {
                admitted: false,
                error: Some(code),
                reason: Some(full),
            })
        }
    }
}

#[derive(Deserialize)]
struct FitnessRequest {
    fitness: FitnessVector,
    /// Optional — defaults to the ADR-392 §14 first production profile.
    #[serde(default)]
    gates: Option<HardGates>,
}

#[derive(Serialize)]
struct FitnessResponse {
    passes: bool,
    gates: HardGates,
}

/// The promotion hard-gate (min-semantics): does this candidate clear every
/// constitutional minimum? Weighted ranking applies only among those that pass.
async fn agl_fitness(Json(req): Json<FitnessRequest>) -> Json<FitnessResponse> {
    let gates = req.gates.unwrap_or_default();
    Json(FitnessResponse {
        passes: req.fitness.passes_hard_gates(&gates),
        gates,
    })
}

// ---- Canary automation (ADR-392 §6.1 staged rollout) --------------------
// Stateless: the caller threads the `CanaryController` (it is Serialize), so the
// service stays a pure transform, is durable across restarts, and scales to
// zero. `new` starts a rollout at 1%; each `observe` feeds one fitness
// measurement and returns the deterministic decision — advance 1→10→50→100,
// hold, ready-for-promotion, or automatic rollback on a hard-gate violation.

#[derive(Deserialize)]
struct CanaryNewRequest {
    candidate_id: String,
    rollback_target: String,
    /// Healthy observations required per stage before advancing (min 1).
    #[serde(default = "one")]
    observations_per_stage: u32,
    #[serde(default)]
    gates: Option<HardGates>,
}
fn one() -> u32 {
    1
}

#[derive(Serialize)]
struct CanaryStateResponse {
    controller: CanaryController,
    stage_pct: Option<u8>,
}

/// Start a canary rollout for a candidate.
async fn canary_new(Json(req): Json<CanaryNewRequest>) -> Json<CanaryStateResponse> {
    let controller = CanaryController::new(
        &req.candidate_id,
        &req.rollback_target,
        req.gates.unwrap_or_default(),
        req.observations_per_stage,
    );
    let stage_pct = controller.stage_pct();
    Json(CanaryStateResponse {
        controller,
        stage_pct,
    })
}

#[derive(Deserialize)]
struct CanaryObserveRequest {
    controller: CanaryController,
    fitness: FitnessVector,
}

#[derive(Serialize)]
struct CanaryObserveResponse {
    controller: CanaryController,
    decision: Decision,
    stage_pct: Option<u8>,
}

/// Feed one fitness measurement; get the next canary decision (deterministic).
async fn canary_observe(Json(mut req): Json<CanaryObserveRequest>) -> Json<CanaryObserveResponse> {
    let decision = req.controller.observe(&req.fitness);
    let stage_pct = req.controller.stage_pct();
    Json(CanaryObserveResponse {
        controller: req.controller,
        decision,
        stage_pct,
    })
}

// ---- Signed promotion (ADR-394 cryptographic closure) -------------------
// The verifier role (ADR-392 §11): the service does NOT sign as a judge — it
// verifies independently-produced, ed25519-signed evaluation receipts (≥2
// distinct pinned judges, beats-parent) against the constitution's pinned keys,
// then finalizes the canary. Every input is content-bound; there is no
// caller-supplied boolean. `verify_promotion_artifact` returns EVERY violation.

#[derive(Deserialize)]
struct PromoteRequest {
    constitution: Constitution,
    parent: Genome,
    manifest: CandidateManifest,
    receipts: Vec<EvaluationReceipt>,
    envelope: PromotionEnvelope,
    #[serde(default)]
    proof_artifacts: Vec<ProofArtifact>,
    /// The canary controller (must be at 100% healthy to finalize).
    controller: CanaryController,
    now: u64,
}

#[derive(Serialize)]
struct PromoteResponse {
    promoted: bool,
    /// The promotion signature (the envelope nonce) when promoted.
    signature: Option<String>,
    /// The controller after the transition (state `Promoted` on success).
    controller: CanaryController,
    /// Every independent reason the promotion was refused (empty on success).
    rejects: Vec<String>,
}

/// Verify a signed promotion bundle and, if clean, finalize the canary.
async fn promote(Json(req): Json<PromoteRequest>) -> Json<PromoteResponse> {
    let mut controller = req.controller;
    match verify_promotion_artifact(
        &req.constitution,
        &req.parent,
        &req.manifest,
        &req.receipts,
        &req.envelope,
        &req.proof_artifacts,
        req.now,
    ) {
        Ok(vp) => match controller.promote(&vp, req.now) {
            Ok(()) => {
                let signature = match &controller.state {
                    CanaryState::Promoted { signature } => Some(signature.clone()),
                    _ => None,
                };
                Json(PromoteResponse {
                    promoted: true,
                    signature,
                    controller,
                    rejects: vec![],
                })
            }
            Err(e) => Json(PromoteResponse {
                promoted: false,
                signature: None,
                controller,
                rejects: vec![e],
            }),
        },
        Err(rejects) => Json(PromoteResponse {
            promoted: false,
            signature: None,
            controller,
            rejects: rejects.iter().map(|r| format!("{r:?}")).collect(),
        }),
    }
}

// ---- Independent judges pipeline (ADR-392 §11 evaluator separation) ------
// The judges ORIGINATE the signed evaluation receipts the promote path verifies.
// Separation that matters: the *builder* (the Slack agent) never holds a judge
// key — the autogenous service is the independent judge+verifier authority, and
// promotion still re-verifies every receipt against the constitution's pinned
// keys. Each judge is a distinct ed25519 identity; ≥2 are required.
//
// Keys come from env seeds (64-hex each): `AUTOGENOUS_JUDGE_SEEDS` (comma-
// separated, ≥2) and `AUTOGENOUS_CONTROLLER_SEED`. Absent, deterministic DEV
// keys are used and a warning is logged — production pins real, secret-managed
// keys in the constitution. Physically separating judges onto distinct trust
// domains is a later hardening; the verification boundary already holds here.

fn seed_from_hex(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn judge_authorities() -> Vec<SigningAuthority> {
    match std::env::var("AUTOGENOUS_JUDGE_SEEDS") {
        Ok(v) => {
            let auths: Vec<SigningAuthority> = v
                .split(',')
                .filter_map(seed_from_hex)
                .enumerate()
                .map(|(i, seed)| SigningAuthority::from_seed(&format!("judge-{}", i + 1), seed))
                .collect();
            if auths.len() >= 2 {
                return auths;
            }
            tracing::warn!("AUTOGENOUS_JUDGE_SEEDS has <2 valid seeds; using DEV judge keys");
            dev_judges()
        }
        Err(_) => {
            tracing::warn!("AUTOGENOUS_JUDGE_SEEDS unset; using DEV judge keys (pin real keys in prod)");
            dev_judges()
        }
    }
}

fn dev_judges() -> Vec<SigningAuthority> {
    vec![
        SigningAuthority::from_seed("judge-1", [1u8; 32]),
        SigningAuthority::from_seed("judge-2", [2u8; 32]),
    ]
}

fn controller_authority() -> SigningAuthority {
    match std::env::var("AUTOGENOUS_CONTROLLER_SEED").ok().and_then(|s| seed_from_hex(&s)) {
        Some(seed) => SigningAuthority::from_seed("controller", seed),
        None => SigningAuthority::from_seed("controller", [3u8; 32]),
    }
}

#[derive(Serialize)]
struct JudgeKeys {
    judges: Vec<String>,
    controller: String,
}

/// Expose the service's judge + controller public keys, so a constitution can
/// pin them (the pinned-key policy is externally governed, ADR-392 §4.1).
async fn judges_keys() -> Json<JudgeKeys> {
    Json(JudgeKeys {
        judges: judge_authorities().iter().map(|a| a.public_hex()).collect(),
        controller: controller_authority().public_hex(),
    })
}

#[derive(Deserialize)]
struct EvaluateRequest {
    constitution: Constitution,
    parent: Genome,
    manifest: CandidateManifest,
    candidate_detector: Detector,
    parent_detector: Detector,
    corpus: Corpus,
    #[serde(default = "corpus_v1")]
    corpus_id: String,
    #[serde(default = "one_f64")]
    p99_overhead_ms: f64,
    nonce: String,
    #[serde(default = "ttl_default")]
    ttl_secs: u64,
    now: u64,
}
fn corpus_v1() -> String {
    "corpus-v1".into()
}
fn one_f64() -> f64 {
    1.0
}
fn ttl_default() -> u64 {
    600
}

#[derive(Serialize)]
struct EvaluateResponse {
    /// One signed receipt per judge (empty on refusal).
    receipts: Vec<EvaluationReceipt>,
    /// The controller-signed promotion envelope binding the receipts.
    envelope: Option<PromotionEnvelope>,
    /// Present on refusal (e.g. the service's keys aren't pinned).
    error: Option<String>,
}

/// The judges evaluate the candidate vs the parent on the submitted corpus and
/// EACH sign a receipt; the controller signs an envelope binding them. Refuses
/// to sign under a constitution that does not pin the service's keys.
async fn judges_evaluate(Json(req): Json<EvaluateRequest>) -> Json<EvaluateResponse> {
    let judges = judge_authorities();
    let controller = controller_authority();
    // Refuse to originate evidence under a constitution that doesn't pin us —
    // the key policy is constitutionally governed, not self-asserted.
    let pinned = &req.constitution.pinned_keys;
    if !judges.iter().all(|j| pinned.judges.contains(&j.public_hex()))
        || !pinned.controllers.contains(&controller.public_hex())
    {
        return Json(EvaluateResponse {
            receipts: vec![],
            envelope: None,
            error: Some(
                "this service's judge/controller keys are not pinned in the submitted constitution".into(),
            ),
        });
    }

    let cand_hash = req.manifest.candidate_hash();
    let parent_hash = content_hash(&req.parent.hash);
    let mut idx = 0u8;
    let receipts: Vec<EvaluationReceipt> = judges
        .iter()
        .map(|judge| {
            idx += 1;
            evaluate_and_sign(
                judge,
                &cand_hash,
                &parent_hash,
                &req.candidate_detector,
                &req.parent_detector,
                &req.corpus,
                &req.corpus_id,
                &format!("eval-{idx}"),
                req.p99_overhead_ms,
                req.now,
            )
        })
        .collect();
    let envelope = PromotionEnvelope::signed(
        &controller,
        &req.constitution.hash(),
        &cand_hash,
        &receipts,
        &req.nonce,
        req.now,
        req.ttl_secs,
    );
    Json(EvaluateResponse {
        receipts,
        envelope: Some(envelope),
        error: None,
    })
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(health))
        .route("/v1/agl/admit", post(agl_admit))
        .route("/v1/agl/fitness", post(agl_fitness))
        .route("/v1/canary/new", post(canary_new))
        .route("/v1/canary/observe", post(canary_observe))
        .route("/v1/judges/keys", get(judges_keys))
        .route("/v1/judges/evaluate", post(judges_evaluate))
        .route("/v1/promote", post(promote));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind $PORT");
    tracing::info!(port, version = VERSION, "autogenous-service up");

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutdown signal");
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .expect("serve");
}
