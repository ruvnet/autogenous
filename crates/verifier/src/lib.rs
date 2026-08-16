//! # verifier — the AGL admission verdict (ADR-392 Phase 3)
//!
//! Composes every structural check into one verdict: constitution pinning,
//! typed mutation admission (authority, invariants, rollback, expiry — from
//! `agl-types`), prohibited effects, and the hard fitness gates. Returns the
//! **complete list** of violations (a failure explanation, not just a boolean).
//!
//! The verifier is deliberately **separable** from the generator and the
//! runtime (ADR-392 §3.4): it holds no mutable state, takes everything as
//! input, and is deterministic — the same inputs always produce the same
//! verdict, so an independently-operated verifier can re-check any promotion.

use agl_types::{AdmissionError, FitnessVector, Genome, Mutation};
use constitution::Constitution;
use serde::{Deserialize, Serialize};

/// A declared side-effect of a mutation, checked against the constitution's
/// prohibited list.
pub type Effect = String;

/// The full verdict: admissible + promotable, with explanations.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Verdict {
    pub admissible: bool,
    pub promotable: bool,
    pub violations: Vec<String>,
}

/// Verify a candidate end-to-end. `declared_effects` are the mutation's declared
/// side-effects; `fitness` is the evaluator's measured vector (None = not yet
/// evaluated, so not promotable). `now` is unix seconds, passed in so the check
/// is clock-free and reproducible.
pub fn verify(
    constitution: &Constitution,
    parent: &Genome,
    mutation: &Mutation,
    declared_effects: &[Effect],
    fitness: Option<&FitnessVector>,
    now: u64,
) -> Verdict {
    let mut violations = Vec::new();

    // 1. Constitution pinning: the genome must pin the deployed constitution.
    if parent.constitution != constitution.hash() {
        violations.push(format!(
            "constitution mismatch: genome pins {}, deployed is {}",
            parent.constitution,
            constitution.hash()
        ));
    }

    // 2. Typed admission (authority, invariants, rollback, expiry, scope).
    if let Err(e) = mutation.admissible(parent, now) {
        violations.push(admission_reason(&e));
    }

    // 3. Ceiling alignment: the genome's own ceiling cannot exceed the
    //    constitution's (a genome cannot smuggle authority).
    if parent.capability_ceiling > constitution.authority_ceiling {
        violations.push(format!(
            "genome ceiling {:?} exceeds constitutional ceiling {:?}",
            parent.capability_ceiling, constitution.authority_ceiling
        ));
    }

    // 4. Prohibited effects.
    for eff in declared_effects {
        if constitution.prohibits(eff) {
            violations.push(format!("prohibited effect: {eff}"));
        }
    }

    let admissible = violations.is_empty();

    // 5. Promotion needs measured fitness passing the constitutional hard gates.
    let promotable = match fitness {
        Some(f) if admissible => {
            if f.passes_hard_gates(&constitution.hard_gates) {
                true
            } else {
                violations.push("fitness fails constitutional hard gates".into());
                false
            }
        }
        Some(_) => false,
        None => {
            violations.push("no measured fitness — evaluate before promotion".into());
            false
        }
    };

    Verdict { admissible, promotable, violations }
}

fn admission_reason(e: &AdmissionError) -> String {
    match e {
        AdmissionError::AuthorityExpansion { requested, ceiling } => {
            format!("authority expansion: requested {requested:?} > ceiling {ceiling:?}")
        }
        AdmissionError::AuthorityInsufficient { requested, required } => {
            format!("authority insufficient: {requested:?} < scope minimum {required:?}")
        }
        AdmissionError::InvariantRegressed(name) => format!("hard invariant regressed: {name}"),
        AdmissionError::ParentMismatch => "parent genome hash mismatch".into(),
        AdmissionError::ConstitutionalScope => "constitutional scope is never auto-admissible".into(),
        AdmissionError::NoRollback => "no rollback target — irreversible".into(),
        AdmissionError::Expired => "mutation expired".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agl_types::{Applicability, Authority, HardGates, HardInvariant, MutationScope};

    fn constitution() -> Constitution {
        Constitution {
            identity: "t".into(),
            version: 1,
            authority_ceiling: Authority::Governed,
            prohibited_effects: vec!["pii_egress".into()],
            hard_gates: HardGates::default(),
            signers: vec!["a".into(), "b".into()],
            effective_at: 0,
        }
    }
    fn genome(c: &Constitution) -> Genome {
        Genome {
            hash: "g0".into(),
            identity: "org".into(),
            constitution: c.hash(),
            capability_ceiling: Authority::Governed,
            hard_invariants: vec![HardInvariant { name: "iso".into(), holds: true }],
            lineage: vec![],
        }
    }
    fn mutation() -> Mutation {
        Mutation {
            id: "m".into(),
            parent_genome_hash: "g0".into(),
            scope: MutationScope::RetrievalRerank,
            requested_authority: Authority::AutoReversible,
            applicability: Applicability::default(),
            preserved_invariants: vec![HardInvariant { name: "iso".into(), holds: true }],
            rollback_target: Some("g0".into()),
            expires_at: None,
            signature: Some("s".into()),
        }
    }
    fn good_fitness() -> FitnessVector {
        FitnessVector {
            task_quality: 0.9,
            safety: 0.999,
            governance: 1.0,
            reliability: 0.99,
            p99_overhead_ms: 1.0,
            false_positive_rate: 0.001,
            regression_count: 0,
            rollback_verified: true,
        }
    }

    #[test]
    fn clean_candidate_is_admissible_and_promotable() {
        let c = constitution();
        let v = verify(&c, &genome(&c), &mutation(), &[], Some(&good_fitness()), 0);
        assert!(v.admissible && v.promotable, "{:?}", v.violations);
    }

    #[test]
    fn verifier_rejects_capability_expansion_even_with_perfect_fitness() {
        // ADR-392 §23 final acceptance property: an independent verifier must
        // reject a high-performing candidate that violates one invariant.
        let c = constitution();
        let mut m = mutation();
        m.scope = MutationScope::SecurityPolicy;
        m.requested_authority = Authority::Constitutional; // expansion
        let v = verify(&c, &genome(&c), &m, &[], Some(&good_fitness()), 0);
        assert!(!v.admissible && !v.promotable);
        assert!(v.violations.iter().any(|x| x.contains("authority expansion")));
    }

    #[test]
    fn prohibited_effects_block_admission() {
        let c = constitution();
        let v = verify(&c, &genome(&c), &mutation(), &["pii_egress".into()], Some(&good_fitness()), 0);
        assert!(!v.admissible);
        assert!(v.violations.iter().any(|x| x.contains("prohibited effect")));
    }

    #[test]
    fn unevaluated_candidates_are_never_promotable() {
        let c = constitution();
        let v = verify(&c, &genome(&c), &mutation(), &[], None, 0);
        assert!(v.admissible && !v.promotable);
    }

    #[test]
    fn constitution_mismatch_is_detected() {
        let c = constitution();
        let mut g = genome(&c);
        g.constitution = "stale".into();
        let v = verify(&c, &g, &mutation(), &[], Some(&good_fitness()), 0);
        assert!(!v.admissible);
    }
}
