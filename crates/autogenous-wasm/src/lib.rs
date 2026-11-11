//! WebAssembly boundary for the `autogenous` npm package.
//!
//! Every function takes and returns JSON strings so the JavaScript side never
//! depends on wasm-bindgen object layouts. The logic is entirely `agl-types`;
//! this crate only parses, bounds and serializes.
#![forbid(unsafe_code)]

use agl_types::{AdmissionError, FitnessVector, Genome, HardGates, Mutation, MutationScope};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Upper bound on any single JSON argument (bytes).
pub const MAX_INPUT_BYTES: usize = 65_536;

fn bounded(input: &str, what: &str) -> Result<(), String> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(format!("{what} exceeds {MAX_INPUT_BYTES} bytes"));
    }
    Ok(())
}

fn parse<T: serde::de::DeserializeOwned>(input: &str, what: &str) -> Result<T, String> {
    bounded(input, what)?;
    serde_json::from_str(input).map_err(|e| format!("invalid {what}: {e}"))
}

fn to_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("serialization failed: {e}"))
}

#[derive(Serialize)]
struct AdmissionResult {
    admissible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AdmissionError>,
}

/// Run `Mutation::admissible(parent, now)`. Pure: `now` is unix seconds.
pub fn admit_mutation(mutation: &str, parent: &str, now: u64) -> Result<String, String> {
    let mutation: Mutation = parse(mutation, "mutation")?;
    let parent: Genome = parse(parent, "parent genome")?;
    let result = match mutation.admissible(&parent, now) {
        Ok(()) => AdmissionResult {
            admissible: true,
            error: None,
        },
        Err(e) => AdmissionResult {
            admissible: false,
            error: Some(e),
        },
    };
    to_json(&result)
}

#[derive(Serialize)]
struct ScopePolicy {
    scope: MutationScope,
    auto_promotable: bool,
    min_authority: agl_types::Authority,
}

/// `MutationScope::auto_promotable` and `min_authority` for one scope.
pub fn scope_policy(scope: &str) -> Result<String, String> {
    let scope: MutationScope = parse(
        &serde_json::to_string(scope).map_err(|e| e.to_string())?,
        "scope",
    )?;
    to_json(&ScopePolicy {
        scope,
        auto_promotable: scope.auto_promotable(),
        min_authority: scope.min_authority(),
    })
}

/// `FitnessVector::passes_hard_gates`. `gates` empty means the ADR-392 §14 defaults.
pub fn passes_hard_gates(fitness: &str, gates: &str) -> Result<bool, String> {
    let fitness: FitnessVector = parse(fitness, "fitness vector")?;
    let gates: HardGates = if gates.is_empty() {
        HardGates::default()
    } else {
        parse(gates, "hard gates")?
    };
    Ok(fitness.passes_hard_gates(&gates))
}

/// The ADR-392 §14 default hard gates.
pub fn default_hard_gates() -> Result<String, String> {
    to_json(&HardGates::default())
}

#[wasm_bindgen(js_name = admitMutationJson)]
pub fn admit_mutation_js(mutation: &str, parent: &str, now: f64) -> Result<String, JsValue> {
    if !now.is_finite() || now < 0.0 || now.fract() != 0.0 || now > 9_007_199_254_740_991.0 {
        return Err(JsValue::from_str(
            "now must be a non-negative safe integer (unix seconds)",
        ));
    }
    admit_mutation(mutation, parent, now as u64).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name = scopePolicyJson)]
pub fn scope_policy_js(scope: &str) -> Result<String, JsValue> {
    scope_policy(scope).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name = passesHardGatesJson)]
pub fn passes_hard_gates_js(fitness: &str, gates: &str) -> Result<bool, JsValue> {
    passes_hard_gates(fitness, gates).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name = defaultHardGatesJson)]
pub fn default_hard_gates_js() -> Result<String, JsValue> {
    default_hard_gates().map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARENT: &str = r#"{"hash":"g0","identity":"t","constitution":"c0","capability_ceiling":"governed","hard_invariants":[{"name":"inv","holds":true}],"lineage":[]}"#;

    fn mutation(scope: &str, authority: &str, rollback: &str) -> String {
        format!(
            r#"{{"id":"m1","parent_genome_hash":"g0","scope":"{scope}","requested_authority":"{authority}","applicability":{{"workloads":[],"environments":[],"jurisdictions":[]}},"preserved_invariants":[{{"name":"inv","holds":true}}],"rollback_target":{rollback},"expires_at":null,"signature":null}}"#
        )
    }

    #[test]
    fn admits_reversible_routing_mutation() {
        let out = admit_mutation(
            &mutation("routing_budget", "auto_reversible", "\"g0\""),
            PARENT,
            0,
        )
        .unwrap();
        assert_eq!(out, r#"{"admissible":true}"#);
    }

    #[test]
    fn rejects_missing_rollback_and_constitutional_scope() {
        let out = admit_mutation(
            &mutation("routing_budget", "auto_reversible", "null"),
            PARENT,
            0,
        )
        .unwrap();
        assert!(out.contains("NoRollback"), "{out}");
        let out = admit_mutation(
            &mutation("constitutional", "constitutional", "\"g0\""),
            PARENT,
            0,
        )
        .unwrap();
        assert!(out.contains("ConstitutionalScope"), "{out}");
    }

    #[test]
    fn scope_policy_matches_agl() {
        assert_eq!(
            scope_policy("routing_budget").unwrap(),
            r#"{"scope":"routing_budget","auto_promotable":true,"min_authority":"auto_reversible"}"#
        );
        assert!(scope_policy("not_a_scope").is_err());
    }

    #[test]
    fn hard_gates_default_and_oversize_input() {
        let ok = r#"{"task_quality":1,"safety":1,"governance":1,"reliability":1,"p99_overhead_ms":1,"false_positive_rate":0,"regression_count":0,"rollback_verified":true}"#;
        assert!(passes_hard_gates(ok, "").unwrap());
        let big = "x".repeat(MAX_INPUT_BYTES + 1);
        assert!(passes_hard_gates(&big, "").is_err());
    }
}
