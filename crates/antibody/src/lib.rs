//! # antibody — the Autogenous Antibody Package (ADR-392 §8, Phase 4)
//!
//! An antibody is **not** a detector or a telemetry record: it is an expiring,
//! capability-constrained adaptation carrying its trigger, evidence, detector,
//! containment response, regression corpus, fitness envelope, lineage, and
//! rollback target.
//!
//! Two rules are enforced structurally:
//! - **§8.2**: no neural/statistical trigger may directly authorize an
//!   irreversible action — statistical triggers may only quarantine, buffer,
//!   request cancellation, reduce authority, or start governed evaluation.
//! - **§8.4**: every antibody expires unless renewed by current evidence.

pub mod detector;
pub use detector::{Detector, DetectorError};

use agl_types::{Applicability, Authority, Mutation};
use serde::{Deserialize, Serialize};

/// Trigger classes (ADR-392 §8.2). `symbolic()` distinguishes exact/logical
/// triggers from statistical ones (which get restricted containment authority).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    ExactPattern {
        pattern: String,
    },
    TemporalLogicViolation {
        formula: String,
    },
    DistributionShift {
        metric: String,
        threshold_sigma: F64Bits,
    },
    AttractorTransition {
        from: String,
        to: String,
    },
    ResourceBudgetViolation {
        budget: String,
    },
    CapabilityMisuse {
        capability: String,
    },
    WitnessChainInconsistency,
    CausalIncidentPattern {
        pattern_id: String,
    },
}

/// f64 wrapper with Eq via bit pattern (triggers must be hashable/comparable).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct F64Bits(pub f64);
impl PartialEq for F64Bits {
    fn eq(&self, o: &Self) -> bool {
        self.0.to_bits() == o.0.to_bits()
    }
}
impl Eq for F64Bits {}

impl Trigger {
    /// Exact symbolic / logical triggers may authorize containment up to the
    /// antibody's authority. Statistical/learned triggers may not authorize
    /// irreversible actions (§8.2).
    pub fn symbolic(&self) -> bool {
        matches!(
            self,
            Trigger::ExactPattern { .. }
                | Trigger::TemporalLogicViolation { .. }
                | Trigger::ResourceBudgetViolation { .. }
                | Trigger::CapabilityMisuse { .. }
                | Trigger::WitnessChainInconsistency
        )
    }
}

/// Immediate containment responses, ordered by severity. Only the reversible
/// subset is available to statistical triggers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Containment {
    Observe,
    Buffer,
    Quarantine,
    RequestCancellation,
    ReduceAuthority,
    StartGovernedEvaluation,
    /// Irreversible: terminate the stream/session. Symbolic triggers only.
    Terminate,
}

impl Containment {
    pub fn reversible(self) -> bool {
        !matches!(self, Containment::Terminate)
    }
}

/// Signed evidence receipt (witness reference, not raw traffic — §8.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvidenceReceipt {
    pub witness_ref: String,
    /// Derived (privacy-preserving) representation, never raw customer traffic
    /// unless policy allows; `derived=false` requires an explicit policy ref.
    pub derived: bool,
    pub data_policy_ref: Option<String>,
}

/// The Autogenous Antibody Package (§8.1, admission-relevant core).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Antibody {
    pub id: String,
    pub issuer: String,
    pub parent_genome_hash: String,
    pub trigger: Trigger,
    /// The serializable, sandbox-safe detector this antibody ships (§8.1.7).
    pub detector: Detector,
    pub evidence: Vec<EvidenceReceipt>,
    pub containment: Containment,
    /// The typed genome mutation this antibody proposes (may be None for pure
    /// observe/contain antibodies).
    pub proposed_mutation: Option<Mutation>,
    pub applicability: Applicability,
    /// References to the regression corpus + counterexample set.
    pub regression_corpus_ref: String,
    pub counterexamples_ref: String,
    pub requested_authority: Authority,
    pub prohibited_effects: Vec<String>,
    /// Unix seconds. REQUIRED — antibodies always expire (§8.4).
    pub expires_at: u64,
    pub revocation_channel: String,
    pub rollback_target: String,
    pub signature: Option<String>,
}

/// Why an antibody is invalid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AntibodyError {
    /// Statistical trigger paired with an irreversible containment (§8.2).
    StatisticalTriggerIrreversible,
    /// Raw (non-derived) evidence without an explicit data policy (§8.3).
    RawEvidenceWithoutPolicy,
    /// Expired (or expiry missing semantics: expires_at == 0).
    Expired,
    NoEvidence,
    NoRollback,
    Unsigned,
    /// The shipped detector fails structural validation (resource bounds etc.).
    InvalidDetector(DetectorError),
}

impl Antibody {
    /// Structural validation. `now` in unix seconds (clock passed in).
    pub fn validate(&self, now: u64) -> Result<(), AntibodyError> {
        if !self.trigger.symbolic() && !self.containment.reversible() {
            return Err(AntibodyError::StatisticalTriggerIrreversible);
        }
        for e in &self.evidence {
            if !e.derived && e.data_policy_ref.is_none() {
                return Err(AntibodyError::RawEvidenceWithoutPolicy);
            }
        }
        if self.expires_at == 0 || now >= self.expires_at {
            return Err(AntibodyError::Expired);
        }
        if self.evidence.is_empty() {
            return Err(AntibodyError::NoEvidence);
        }
        if self.rollback_target.trim().is_empty() {
            return Err(AntibodyError::NoRollback);
        }
        if self.signature.is_none() {
            return Err(AntibodyError::Unsigned);
        }
        self.detector
            .validate()
            .map_err(AntibodyError::InvalidDetector)?;
        Ok(())
    }

    /// Renewal (§8.4): extend expiry, citing fresh evidence. Returns a NEW
    /// antibody — packages are immutable once signed.
    pub fn renew(&self, fresh_evidence: EvidenceReceipt, new_expiry: u64) -> Antibody {
        let mut next = self.clone();
        next.evidence.push(fresh_evidence);
        next.expires_at = new_expiry;
        next.signature = None; // must be re-signed
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> EvidenceReceipt {
        EvidenceReceipt {
            witness_ref: "w1".into(),
            derived: true,
            data_policy_ref: None,
        }
    }

    fn antibody() -> Antibody {
        Antibody {
            id: "aap-1".into(),
            issuer: "deployment-a".into(),
            parent_genome_hash: "g0".into(),
            trigger: Trigger::ExactPattern {
                pattern: "ignore previous instructions".into(),
            },
            detector: Detector::Contains {
                needle: "ignore previous instructions".into(),
            },
            evidence: vec![receipt()],
            containment: Containment::Quarantine,
            proposed_mutation: None,
            applicability: Applicability::default(),
            regression_corpus_ref: "corpus-7".into(),
            counterexamples_ref: "cx-7".into(),
            requested_authority: Authority::AutoReversible,
            prohibited_effects: vec![],
            expires_at: 2_000_000_000,
            revocation_channel: "radio://revocations".into(),
            rollback_target: "g0".into(),
            signature: Some("sig".into()),
        }
    }

    #[test]
    fn valid_antibody_passes() {
        assert_eq!(antibody().validate(1_900_000_000), Ok(()));
    }

    #[test]
    fn statistical_trigger_cannot_terminate() {
        let mut a = antibody();
        a.trigger = Trigger::DistributionShift {
            metric: "entropy".into(),
            threshold_sigma: F64Bits(3.0),
        };
        a.containment = Containment::Terminate;
        assert_eq!(
            a.validate(0),
            Err(AntibodyError::StatisticalTriggerIrreversible)
        );
        // …but it may quarantine.
        a.containment = Containment::Quarantine;
        assert_eq!(a.validate(1_900_000_000), Ok(()));
    }

    #[test]
    fn raw_evidence_needs_a_policy() {
        let mut a = antibody();
        a.evidence = vec![EvidenceReceipt {
            witness_ref: "w".into(),
            derived: false,
            data_policy_ref: None,
        }];
        assert_eq!(a.validate(0), Err(AntibodyError::RawEvidenceWithoutPolicy));
    }

    #[test]
    fn antibodies_always_expire() {
        let mut a = antibody();
        assert_eq!(a.validate(2_000_000_001), Err(AntibodyError::Expired));
        a.expires_at = 0; // "never expires" is invalid by construction
        assert_eq!(a.validate(0), Err(AntibodyError::Expired));
    }

    #[test]
    fn renewal_extends_expiry_but_drops_signature() {
        let a = antibody();
        let r = a.renew(receipt(), 2_100_000_000);
        assert_eq!(r.expires_at, 2_100_000_000);
        assert_eq!(r.evidence.len(), 2);
        assert_eq!(r.validate(2_050_000_000), Err(AntibodyError::Unsigned));
    }
}
