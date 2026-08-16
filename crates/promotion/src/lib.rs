//! # promotion — the canary controller (ADR-392 Phase 6)
//!
//! A deterministic state machine that walks a verified candidate through the
//! staged rollout `1% → 10% → 50% → 100%`, advancing only while measured
//! fitness keeps passing the constitutional hard gates, and **rolling back
//! automatically** on the first violation. Promotion at 100% requires a
//! signature; rollback requires nothing (it is the safe direction).
//!
//! The controller never evaluates and never generates — it only consumes
//! verdicts and measurements (evaluator separation, ADR-392 §11).

use agl_types::{FitnessVector, HardGates};
use serde::{Deserialize, Serialize};

/// Rollout stages in percent of traffic.
pub const STAGES: [u8; 4] = [1, 10, 50, 100];

/// Controller state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CanaryState {
    /// Serving `STAGES[idx]`% of traffic, awaiting measurements.
    Serving {
        stage_idx: usize,
        healthy_observations: u32,
    },
    /// Fully promoted (signed).
    Promoted { signature: String },
    /// Rolled back to the parent; terminal for this candidate.
    RolledBack { at_stage_pct: u8, reason: String },
}

/// What the controller decided after an observation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Decision {
    Hold,
    Advance { to_pct: u8 },
    ReadyForPromotion,
    RollBack { reason: String },
}

/// The canary controller for one candidate.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CanaryController {
    pub candidate_id: String,
    pub rollback_target: String,
    pub gates: HardGates,
    /// Healthy observations required per stage before advancing.
    pub observations_per_stage: u32,
    pub state: CanaryState,
    /// Signed promotion/rollback audit records, oldest first.
    pub audit: Vec<String>,
}

impl CanaryController {
    pub fn new(
        candidate_id: &str,
        rollback_target: &str,
        gates: HardGates,
        observations_per_stage: u32,
    ) -> Self {
        CanaryController {
            candidate_id: candidate_id.into(),
            rollback_target: rollback_target.into(),
            gates,
            observations_per_stage: observations_per_stage.max(1),
            state: CanaryState::Serving {
                stage_idx: 0,
                healthy_observations: 0,
            },
            audit: vec![format!("start canary at {}%", STAGES[0])],
        }
    }

    /// Current traffic share, if serving.
    pub fn stage_pct(&self) -> Option<u8> {
        match &self.state {
            CanaryState::Serving { stage_idx, .. } => Some(STAGES[*stage_idx]),
            _ => None,
        }
    }

    /// Feed one fitness measurement from the current stage. Deterministic.
    pub fn observe(&mut self, fitness: &FitnessVector) -> Decision {
        let (stage_idx, healthy) = match &self.state {
            CanaryState::Serving {
                stage_idx,
                healthy_observations,
            } => (*stage_idx, *healthy_observations),
            _ => return Decision::Hold, // terminal states ignore input
        };
        if !fitness.passes_hard_gates(&self.gates) {
            let reason = "hard-gate violation during canary".to_string();
            self.audit.push(format!(
                "ROLLBACK at {}% -> {} ({reason})",
                STAGES[stage_idx], self.rollback_target
            ));
            self.state = CanaryState::RolledBack {
                at_stage_pct: STAGES[stage_idx],
                reason: reason.clone(),
            };
            return Decision::RollBack { reason };
        }
        let healthy = healthy + 1;
        if healthy < self.observations_per_stage {
            self.state = CanaryState::Serving {
                stage_idx,
                healthy_observations: healthy,
            };
            return Decision::Hold;
        }
        // Stage complete.
        if stage_idx + 1 < STAGES.len() {
            let next = stage_idx + 1;
            self.audit.push(format!(
                "advance {}% -> {}%",
                STAGES[stage_idx], STAGES[next]
            ));
            self.state = CanaryState::Serving {
                stage_idx: next,
                healthy_observations: 0,
            };
            Decision::Advance {
                to_pct: STAGES[next],
            }
        } else {
            // 100% healthy — persist the completed count so `promote` can see
            // the final stage is done; promotion still requires a signature.
            self.state = CanaryState::Serving {
                stage_idx,
                healthy_observations: healthy,
            };
            Decision::ReadyForPromotion
        }
    }

    /// Sign the promotion. Only valid when the final stage completed healthy.
    /// Zero unsigned promotions (ADR-392 §14): without this call the candidate
    /// never becomes `Promoted`.
    pub fn promote(&mut self, signature: &str) -> Result<(), String> {
        match &self.state {
            CanaryState::Serving {
                stage_idx,
                healthy_observations,
            } if *stage_idx == STAGES.len() - 1
                && *healthy_observations >= self.observations_per_stage =>
            {
                self.audit.push(format!("PROMOTED (signed: {signature})"));
                self.state = CanaryState::Promoted {
                    signature: signature.into(),
                };
                Ok(())
            }
            CanaryState::Promoted { .. } => Err("already promoted".into()),
            _ => Err("canary not complete — refusing unsigned/early promotion".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> FitnessVector {
        FitnessVector {
            task_quality: 0.95,
            safety: 0.995,
            governance: 1.0,
            reliability: 0.99,
            p99_overhead_ms: 2.0,
            false_positive_rate: 0.001,
            regression_count: 0,
            rollback_verified: true,
        }
    }
    fn bad() -> FitnessVector {
        let mut f = good();
        f.regression_count = 1;
        f
    }

    #[test]
    fn full_healthy_rollout_reaches_promotion_only_with_signature() {
        let mut c = CanaryController::new("cand", "g0", HardGates::default(), 2);
        let mut ready = false;
        for _ in 0..8 {
            if c.observe(&good()) == Decision::ReadyForPromotion {
                ready = true;
                break;
            }
        }
        assert!(ready, "audit: {:?}", c.audit);
        // Unsigned promotion is impossible; signed succeeds.
        assert!(matches!(c.state, CanaryState::Serving { .. }));
        c.promote("ed25519:release-key").unwrap();
        assert!(matches!(c.state, CanaryState::Promoted { .. }));
    }

    #[test]
    fn injected_regression_rolls_back_automatically() {
        let mut c = CanaryController::new("cand", "g0", HardGates::default(), 2);
        c.observe(&good());
        c.observe(&good()); // advance to 10%
        assert_eq!(c.stage_pct(), Some(10));
        let d = c.observe(&bad()); // injected regression
        assert!(matches!(d, Decision::RollBack { .. }));
        assert!(matches!(
            c.state,
            CanaryState::RolledBack {
                at_stage_pct: 10,
                ..
            }
        ));
        // Terminal: further observations are ignored, promotion refused.
        assert_eq!(c.observe(&good()), Decision::Hold);
        assert!(c.promote("sig").is_err());
    }

    #[test]
    fn early_promotion_is_refused() {
        let mut c = CanaryController::new("cand", "g0", HardGates::default(), 3);
        c.observe(&good());
        assert!(c.promote("sig").is_err(), "must not promote from 1% stage");
    }
}
