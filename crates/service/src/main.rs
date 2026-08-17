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
use serde::{Deserialize, Serialize};

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
        .route("/v1/agl/fitness", post(agl_fitness));

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
