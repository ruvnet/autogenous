//! # agl-types — the Autogenous Genome Language, typed
//!
//! Core types of the **Autogenous Runtime** (ADR-392/393): a mutation is not a
//! text patch — it is a **typed transformation between valid genomes** that
//! declares what it changes, why it should work, where it is valid, what
//! authority it requires, which invariants it preserves, how it was tested,
//! when it expires, and how to reverse it.
//!
//! Two structural rules are enforced *in the types and admission check*, not by
//! convention:
//!
//! 1. **Authority never silently expands.** A mutation may request *less*
//!    authority than its parent genome's ceiling, never more
//!    ([`Mutation::admissible`]).
//! 2. **Promotion is a hard AND-gate over a fitness vector**, not a weighted
//!    sum ([`FitnessVector::passes_hard_gates`]) — exceptional performance in
//!    one dimension can never compensate for a safety or governance failure.
//!
//! Constitutional scope ([`MutationScope::Constitutional`]) is **never**
//! automatically promotable, regardless of evidence.

use serde::{Deserialize, Serialize};

/// Authority classes (ADR-392 §6.3), strictly ordered: a mutation may request an
/// authority class ≤ its parent's ceiling, never greater.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authority {
    ObserveOnly,
    SimulateOnly,
    /// Automatic and immediately reversible (Fast zone).
    AutoReversible,
    /// Governed deployment (canary + signed promotion).
    Governed,
    /// Constitutional approval required — external human authority.
    Constitutional,
}

/// Mutation scopes in increasing order of risk (ADR-392 §6.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationScope {
    PromptContext,
    RoutingBudget,
    RetrievalRerank,
    CacheMemory,
    AgentTopology,
    ApplicationCode,
    SchemaMigration,
    SecurityPolicy,
    CompilerIr,
    Constitutional,
}

impl MutationScope {
    /// May this scope EVER be automatically promoted (after production
    /// validation)? Scopes 1–4 only; everything above needs governed or
    /// constitutional promotion (ADR-392 §6.1).
    pub fn auto_promotable(self) -> bool {
        matches!(
            self,
            MutationScope::PromptContext
                | MutationScope::RoutingBudget
                | MutationScope::RetrievalRerank
                | MutationScope::CacheMemory
        )
    }

    /// The minimum authority class a mutation in this scope must request.
    pub fn min_authority(self) -> Authority {
        match self {
            MutationScope::PromptContext
            | MutationScope::RoutingBudget
            | MutationScope::RetrievalRerank
            | MutationScope::CacheMemory => Authority::AutoReversible,
            MutationScope::AgentTopology
            | MutationScope::ApplicationCode
            | MutationScope::SchemaMigration
            | MutationScope::SecurityPolicy
            | MutationScope::CompilerIr => Authority::Governed,
            MutationScope::Constitutional => Authority::Constitutional,
        }
    }
}

/// A named hard invariant. Admission requires every invariant true for the
/// parent to remain true for the child (ADR-392 §6).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardInvariant {
    pub name: String,
    /// True when the invariant currently holds (as last verified).
    pub holds: bool,
}

/// The durable genome header a mutation transforms (ADR-392 §5, abridged to the
/// sections admission needs; the full genome adds contracts/grammar/profiles).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Genome {
    /// Content hash of the canonical encoded genome.
    pub hash: String,
    pub identity: String,
    /// Reference (hash) to the externally-governed constitution.
    pub constitution: String,
    /// This genome's capability ceiling — no descendant may exceed it.
    pub capability_ceiling: Authority,
    pub hard_invariants: Vec<HardInvariant>,
    /// Parent genome hashes, oldest first.
    pub lineage: Vec<String>,
}

/// Where a mutation claims validity (ADR-392 §6.2 applicability).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Applicability {
    pub workloads: Vec<String>,
    pub environments: Vec<String>,
    pub jurisdictions: Vec<String>,
}

/// The vector fitness of a candidate (ADR-392 §10). All dimensions in [0,1]
/// except the resource dimensions, which are raw measurements.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FitnessVector {
    pub task_quality: f64,
    pub safety: f64,
    pub governance: f64,
    pub reliability: f64,
    /// Added p99 latency in milliseconds (lower is better).
    pub p99_overhead_ms: f64,
    /// False-positive rate on benign traffic (lower is better).
    pub false_positive_rate: f64,
    /// Number of regressions observed against the parent.
    pub regression_count: u32,
    /// Has a rollback been *executed successfully* in the target environment?
    pub rollback_verified: bool,
}

/// The constitutional minimums a deployment pins (immutable at runtime).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct HardGates {
    pub min_safety: f64,
    pub min_governance: f64,
    pub max_false_positive_rate: f64,
    pub max_p99_overhead_ms: f64,
}

impl Default for HardGates {
    /// ADR-392 §14 first production profile.
    fn default() -> Self {
        HardGates {
            min_safety: 0.99,
            min_governance: 0.99,
            max_false_positive_rate: 0.005,
            max_p99_overhead_ms: 5.0,
        }
    }
}

impl FitnessVector {
    /// The hard AND-gate (ADR-392 §10): every condition must hold; weighted
    /// ranking applies only among candidates that pass. `min`-semantics — one
    /// failed dimension fails the candidate.
    pub fn passes_hard_gates(&self, gates: &HardGates) -> bool {
        self.safety >= gates.min_safety
            && self.governance >= gates.min_governance
            && self.false_positive_rate <= gates.max_false_positive_rate
            && self.p99_overhead_ms <= gates.max_p99_overhead_ms
            && self.regression_count == 0
            && self.rollback_verified
    }
}

/// Why a mutation was refused admission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdmissionError {
    /// Requested authority exceeds the parent genome's capability ceiling.
    AuthorityExpansion { requested: Authority, ceiling: Authority },
    /// Requested authority is below what the scope requires.
    AuthorityInsufficient { requested: Authority, required: Authority },
    /// A hard invariant true for the parent is not preserved.
    InvariantRegressed(String),
    /// Parent hash does not match the supplied parent genome.
    ParentMismatch,
    /// Constitutional scope can never be admitted automatically.
    ConstitutionalScope,
    /// Missing rollback target — irreversible mutations are inadmissible.
    NoRollback,
    /// The mutation has expired.
    Expired,
}

/// A typed mutation between genomes (ADR-392 §6.2, the admission-relevant core).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mutation {
    pub id: String,
    pub parent_genome_hash: String,
    pub scope: MutationScope,
    pub requested_authority: Authority,
    pub applicability: Applicability,
    /// The invariants this mutation claims to preserve, with their
    /// post-transformation status as verified by the evaluator.
    pub preserved_invariants: Vec<HardInvariant>,
    /// Rollback target genome hash — REQUIRED (reversibility is structural).
    pub rollback_target: Option<String>,
    /// Unix seconds after which this mutation is inadmissible.
    pub expires_at: Option<u64>,
    /// Signature envelope (issuer identity + detached signature reference).
    pub signature: Option<String>,
}

impl Mutation {
    /// The admission check (ADR-392 §6): typed, structural, and total. Returns
    /// the FIRST violated rule. `now` is unix seconds (passed in — the check is
    /// deterministic and clock-free for reproducible verification).
    pub fn admissible(&self, parent: &Genome, now: u64) -> Result<(), AdmissionError> {
        if self.parent_genome_hash != parent.hash {
            return Err(AdmissionError::ParentMismatch);
        }
        if self.scope == MutationScope::Constitutional {
            return Err(AdmissionError::ConstitutionalScope);
        }
        // Rule 1: authority may never expand beyond the parent's ceiling.
        if self.requested_authority > parent.capability_ceiling {
            return Err(AdmissionError::AuthorityExpansion {
                requested: self.requested_authority,
                ceiling: parent.capability_ceiling,
            });
        }
        // The scope's own floor (e.g. code changes cannot ride AutoReversible).
        if self.requested_authority < self.scope.min_authority() {
            return Err(AdmissionError::AuthorityInsufficient {
                requested: self.requested_authority,
                required: self.scope.min_authority(),
            });
        }
        // Rule 2: every parent-true invariant must remain true.
        for inv in &parent.hard_invariants {
            if inv.holds {
                let preserved = self
                    .preserved_invariants
                    .iter()
                    .any(|p| p.name == inv.name && p.holds);
                if !preserved {
                    return Err(AdmissionError::InvariantRegressed(inv.name.clone()));
                }
            }
        }
        // Rule 3: reversibility is structural.
        if self.rollback_target.is_none() {
            return Err(AdmissionError::NoRollback);
        }
        // Rule 4: expiry.
        if let Some(exp) = self.expires_at {
            if now >= exp {
                return Err(AdmissionError::Expired);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent() -> Genome {
        Genome {
            hash: "g0".into(),
            identity: "test-organism".into(),
            constitution: "c0".into(),
            capability_ceiling: Authority::Governed,
            hard_invariants: vec![
                HardInvariant { name: "no_pii_egress".into(), holds: true },
                HardInvariant { name: "tenant_isolation".into(), holds: true },
            ],
            lineage: vec![],
        }
    }

    fn mutation() -> Mutation {
        Mutation {
            id: "m1".into(),
            parent_genome_hash: "g0".into(),
            scope: MutationScope::RetrievalRerank,
            requested_authority: Authority::AutoReversible,
            applicability: Applicability::default(),
            preserved_invariants: vec![
                HardInvariant { name: "no_pii_egress".into(), holds: true },
                HardInvariant { name: "tenant_isolation".into(), holds: true },
            ],
            rollback_target: Some("g0".into()),
            expires_at: Some(2_000_000_000),
            signature: Some("sig".into()),
        }
    }

    #[test]
    fn valid_mutation_is_admissible() {
        assert_eq!(mutation().admissible(&parent(), 1_800_000_000), Ok(()));
    }

    #[test]
    fn authority_can_never_expand() {
        // Even a "perfect" mutation requesting Constitutional authority against
        // a Governed ceiling must be refused — the core structural rule.
        let mut m = mutation();
        m.scope = MutationScope::SecurityPolicy;
        m.requested_authority = Authority::Constitutional;
        assert!(matches!(
            m.admissible(&parent(), 0),
            Err(AdmissionError::AuthorityExpansion { .. })
        ));
    }

    #[test]
    fn constitutional_scope_is_never_admissible() {
        let mut m = mutation();
        m.scope = MutationScope::Constitutional;
        m.requested_authority = Authority::Constitutional;
        assert_eq!(m.admissible(&parent(), 0), Err(AdmissionError::ConstitutionalScope));
    }

    #[test]
    fn invariant_regression_is_refused() {
        let mut m = mutation();
        m.preserved_invariants[1].holds = false; // tenant_isolation regressed
        assert_eq!(
            m.admissible(&parent(), 0),
            Err(AdmissionError::InvariantRegressed("tenant_isolation".into()))
        );
    }

    #[test]
    fn irreversible_mutations_are_inadmissible() {
        let mut m = mutation();
        m.rollback_target = None;
        assert_eq!(m.admissible(&parent(), 0), Err(AdmissionError::NoRollback));
    }

    #[test]
    fn code_changes_cannot_ride_auto_reversible() {
        let mut m = mutation();
        m.scope = MutationScope::ApplicationCode;
        m.requested_authority = Authority::AutoReversible;
        assert!(matches!(
            m.admissible(&parent(), 0),
            Err(AdmissionError::AuthorityInsufficient { .. })
        ));
    }

    #[test]
    fn expired_mutations_are_refused() {
        let m = mutation();
        assert_eq!(m.admissible(&parent(), 2_000_000_001), Err(AdmissionError::Expired));
    }

    #[test]
    fn promotion_is_a_hard_and_gate() {
        let gates = HardGates::default();
        let mut f = FitnessVector {
            task_quality: 0.99,
            safety: 0.999,
            governance: 1.0,
            reliability: 0.99,
            p99_overhead_ms: 2.0,
            false_positive_rate: 0.001,
            regression_count: 0,
            rollback_verified: true,
        };
        assert!(f.passes_hard_gates(&gates));
        // Exceptional quality must NOT compensate for a safety miss (min, not Σ).
        f.task_quality = 1.0;
        f.safety = 0.98;
        assert!(!f.passes_hard_gates(&gates));
        // ... or an unverified rollback.
        f.safety = 0.999;
        f.rollback_verified = false;
        assert!(!f.passes_hard_gates(&gates));
    }

    #[test]
    fn serde_round_trip() {
        let m = mutation();
        let json = serde_json::to_string(&m).unwrap();
        let back: Mutation = serde_json::from_str(&json).unwrap();
        assert_eq!(back.admissible(&parent(), 0), Ok(()));
    }

    #[test]
    fn auto_promotable_scopes_are_exactly_one_through_four() {
        use MutationScope::*;
        for s in [PromptContext, RoutingBudget, RetrievalRerank, CacheMemory] {
            assert!(s.auto_promotable());
        }
        for s in [AgentTopology, ApplicationCode, SchemaMigration, SecurityPolicy, CompilerIr, Constitutional] {
            assert!(!s.auto_promotable());
        }
    }
}
