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
use envelope::VerifiedPromotion;
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
    /// Promotion-artifact nonces this controller has already consumed. Enforces
    /// single-use: a `VerifiedPromotion` presented twice is rejected as a replay
    /// (ADR-403 item 1). Cross-process / restart-durable replay protection is
    /// item 4 (a persistent nonce ledger); this covers the in-process guarantee.
    #[serde(default)]
    pub consumed_nonces: Vec<String>,
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
            consumed_nonces: Vec::new(),
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

    /// Consume a [`VerifiedPromotion`] to finalize the rollout (ADR-403 item 1).
    ///
    /// The only way to obtain the argument is a successful
    /// `envelope::verify_promotion_artifact`, so a caller cannot promote a
    /// candidate that did not clear verification. Beyond that, this method
    /// enforces four independent conditions, any of which rejects:
    /// 1. **binding** — the artifact's candidate hash must equal this
    ///    controller's candidate, and its rollback target must match;
    /// 2. **expiry** — `now` (unix secs) must be before the artifact's expiry;
    /// 3. **single-use** — the artifact's nonce must not have been consumed
    ///    before (replay guard);
    /// 4. **canary complete** — the final stage must have completed healthy.
    ///
    /// `now` is the current unix time (clock passed in). Zero unsigned/early
    /// promotions (ADR-392 §14): without a valid artifact the candidate never
    /// becomes `Promoted`.
    pub fn promote(&mut self, promotion: &VerifiedPromotion, now: u64) -> Result<(), String> {
        // (1) binding — the artifact must be for THIS candidate + rollback target.
        if promotion.candidate_hash() != self.candidate_id {
            return Err(format!(
                "promotion artifact bound to a different candidate ({} != {})",
                promotion.candidate_hash(),
                self.candidate_id
            ));
        }
        if promotion.rollback_target() != self.rollback_target {
            return Err(format!(
                "promotion artifact rollback target mismatch ({} != {})",
                promotion.rollback_target(),
                self.rollback_target
            ));
        }
        // (2) expiry — a stale artifact must not actuate.
        if now >= promotion.expires_at() {
            return Err("promotion artifact expired".into());
        }
        // (3) single-use — a replayed artifact is rejected regardless of state.
        if self.consumed_nonces.iter().any(|n| n == promotion.nonce()) {
            return Err("promotion artifact already consumed (replay)".into());
        }
        // (4) canary complete + healthy.
        match &self.state {
            CanaryState::Serving {
                stage_idx,
                healthy_observations,
            } if *stage_idx == STAGES.len() - 1
                && *healthy_observations >= self.observations_per_stage =>
            {
                self.consumed_nonces.push(promotion.nonce().to_string());
                self.audit.push(format!(
                    "PROMOTED (candidate={}, nonce={}, controller={})",
                    promotion.candidate_hash(),
                    promotion.nonce(),
                    promotion.controller_pubkey()
                ));
                self.state = CanaryState::Promoted {
                    signature: promotion.nonce().to_string(),
                };
                Ok(())
            }
            CanaryState::Promoted { .. } => Err("already promoted".into()),
            _ => Err("canary not complete — refusing early promotion".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    /// A VerifiedPromotion bound to candidate `cand`/rollback `rt` with `nonce`,
    /// expiring at NOW+600. Uses the `test-util` constructor (production code
    /// can only obtain one via `verify_promotion_artifact`).
    fn vp(cand: &str, rt: &str, nonce: &str) -> VerifiedPromotion {
        VerifiedPromotion::new_for_test(
            cand.into(),
            "parent-hash".into(),
            "corpus-1".into(),
            vec!["r1".into(), "r2".into()],
            "const-hash".into(),
            "ctrl-pub".into(),
            nonce.into(),
            NOW + 600,
            rt.into(),
        )
    }

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
        // Promotion without a verified artifact is impossible; a valid one succeeds.
        assert!(matches!(c.state, CanaryState::Serving { .. }));
        c.promote(&vp("cand", "g0", "n1"), NOW).unwrap();
        assert!(matches!(c.state, CanaryState::Promoted { .. }));
    }

    #[test]
    fn a_promotion_artifact_is_single_use() {
        // Two controllers for the same candidate; the SAME artifact promotes the
        // first and is rejected as a replay by the second.
        let art = vp("cand", "g0", "nonce-xyz");
        let mut c1 = CanaryController::new("cand", "g0", HardGates::default(), 2);
        for _ in 0..8 {
            if c1.observe(&good()) == Decision::ReadyForPromotion {
                break;
            }
        }
        c1.promote(&art, NOW).unwrap();
        assert!(matches!(c1.state, CanaryState::Promoted { .. }));
        // Re-presenting the exact same controller: already promoted.
        assert!(c1.promote(&art, NOW).is_err());

        let mut c2 = CanaryController::new("cand", "g0", HardGates::default(), 2);
        for _ in 0..8 {
            if c2.observe(&good()) == Decision::ReadyForPromotion {
                break;
            }
        }
        // c2 has already "seen" this nonce injected as consumed → replay.
        c2.consumed_nonces.push("nonce-xyz".into());
        let err = c2.promote(&art, NOW).unwrap_err();
        assert!(err.contains("replay"), "{err}");
    }

    #[test]
    fn promotion_artifact_binding_is_enforced() {
        let mut c = CanaryController::new("cand", "g0", HardGates::default(), 2);
        for _ in 0..8 {
            if c.observe(&good()) == Decision::ReadyForPromotion {
                break;
            }
        }
        // Wrong candidate hash — cannot promote a DIFFERENT candidate here.
        assert!(c.promote(&vp("other-cand", "g0", "n"), NOW).is_err());
        // Wrong rollback target.
        assert!(c.promote(&vp("cand", "g-evil", "n"), NOW).is_err());
        // Expired artifact.
        assert!(c.promote(&vp("cand", "g0", "n"), NOW + 601).is_err());
        // Correct binding + fresh + unexpired → promotes.
        assert!(c.promote(&vp("cand", "g0", "n"), NOW).is_ok());
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
        assert!(c.promote(&vp("cand", "g0", "n"), NOW).is_err());
    }

    #[test]
    fn early_promotion_is_refused() {
        let mut c = CanaryController::new("cand", "g0", HardGates::default(), 3);
        c.observe(&good());
        assert!(
            c.promote(&vp("cand", "g0", "n"), NOW).is_err(),
            "must not promote from 1% stage"
        );
    }
}
