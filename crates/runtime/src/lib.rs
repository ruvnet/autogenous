//! # runtime — the self-running defense loop, on the cryptographically-closed path
//!
//! Gap #7, rebuilt after the security review to run entirely through the
//! `envelope` closure (signed evaluation receipts from ≥2 pinned judges +
//! a signed promotion envelope + content-bound candidate manifests). The runtime
//! never fabricates a `FitnessVector`: judges measure candidate-vs-parent on the
//! same corpus and sign the numbers; the controller signs the promotion; the
//! verifier admits only on independently-verified, content-bound evidence.
//!
//! It measures the SLOs (ADR-392 §14): a novel attack → a *population* of
//! generated candidates → judge-signed evaluation → `verify_promotion` → staged
//! canary → **timed automatic rollback** on an injected regression.

use agl_types::{FitnessVector, Genome, HardGates};
use antibody::{Antibody, Detector};
use constitution::Constitution;
use deployment::verified_rollback;
pub use deployment::{
    DeploymentAdapter, Health, InMemoryAdapter, PromotionGuard, PromotionLockRegistry,
    RollbackReceipt,
};
use envelope::{
    evaluate_and_sign, verify_promotion_artifact, CandidateManifest, EvaluationReceipt,
    InvariantProof, PromotionEnvelope, ProofArtifact, VerifiedPromotion,
};
use evaluator::Corpus;
use generator::{propose, AttackEvidence, GeneratorConfig};
use ledger::{Checkpoint, PromotionLedger, PromotionRecord};
use lineage::{LineageGraph, Node, NodeKind};
use promotion::{CanaryController, Decision};
use std::path::Path;
use witness::{content_hash, SigningAuthority};

/// A clock, injected so timing is deterministic in tests and real in production.
pub trait Clock {
    fn now_millis(&self) -> u128;
    fn now_secs(&self) -> u64;
}

/// A controllable clock for tests.
#[derive(Clone, Debug)]
pub struct TestClock {
    millis: std::cell::Cell<u128>,
    base_secs: u64,
}
impl TestClock {
    pub fn new(base_secs: u64) -> Self {
        TestClock {
            millis: std::cell::Cell::new(0),
            base_secs,
        }
    }
    pub fn advance_ms(&self, d: u128) {
        self.millis.set(self.millis.get() + d);
    }
}
impl Clock for TestClock {
    fn now_millis(&self) -> u128 {
        self.millis.get()
    }
    fn now_secs(&self) -> u64 {
        self.base_secs + (self.millis.get() / 1000) as u64
    }
}

/// A real wall-clock (demo / production). Timestamps are Unix time — used for
/// expiry, receipt stamps, and promotion windows, so they MUST be wall-clock,
/// not process uptime. (Use `Instant` separately if you need elapsed latency.)
#[derive(Default)]
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_millis(&self) -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }
    fn now_secs(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// A candidate that cleared the closed verification (zero rejections).
#[derive(Clone, Debug)]
pub struct ScoredCandidate {
    pub niche: &'static str,
    pub antibody: Antibody,
    pub recall: f64,
    pub fp: f64,
    pub envelope: PromotionEnvelope,
    pub receipts: Vec<EvaluationReceipt>,
    /// The single-use, binding promotion artifact minted from successful
    /// verification (ADR-403 item 1). `run_canary` consumes exactly this to
    /// finalize the rollout — nothing else can promote the candidate.
    pub promotion: VerifiedPromotion,
}

/// The outcome of responding to one attack.
#[derive(Clone, Debug)]
pub struct DefenseOutcome {
    pub population: usize,
    /// Candidates that passed `verify_promotion` with zero rejections.
    pub promotable: usize,
    pub chosen: Option<ScoredCandidate>,
    pub elapsed_ms: u128,
    pub lineage_ids: Vec<String>,
}

/// SLO thresholds (ADR-392 §14).
#[derive(Clone, Copy, Debug)]
pub struct Slos {
    pub max_rollback_init_ms: u128,
    pub max_parent_restore_ms: u128,
}
impl Default for Slos {
    fn default() -> Self {
        Slos {
            max_rollback_init_ms: 10_000,
            max_parent_restore_ms: 60_000,
        }
    }
}

/// Result of driving a verified defense through canary + a possible regression.
#[derive(Clone, Debug)]
pub struct CanaryOutcome {
    pub promoted: bool,
    pub rolled_back: bool,
    pub rollback_init_ms: Option<u128>,
    pub parent_restore_ms: Option<u128>,
    /// The signed proof that the parent was actually restored + confirmed healthy
    /// (finding #6). `None` when no rollback occurred, or a restore was commanded
    /// but could not be confirmed — the latter fails `slos_met`.
    pub rollback_receipt: Option<RollbackReceipt>,
    pub slos_met: bool,
}

/// Result of a lock-guarded rollout (ADR-403 item 2). If `fenced` is true another
/// rollout already holds the target's promotion lock and this one did NOT run —
/// `outcome` is `None` and nothing was promoted or rolled back.
#[derive(Clone, Debug)]
pub struct GuardedCanary {
    pub fenced: bool,
    pub outcome: Option<CanaryOutcome>,
}

/// The runtime: constitution, parent genome + its current (baseline) detector,
/// the four separated authorities, the judge corpus, pinned keys, and lineage.
pub struct Runtime {
    pub constitution: Constitution,
    pub parent: Genome,
    /// The parent's currently-deployed detector (its baseline defense).
    pub parent_detector: Detector,
    pub builder: SigningAuthority,
    pub judge_a: SigningAuthority,
    pub judge_b: SigningAuthority,
    pub controller: SigningAuthority,
    pub corpus: Corpus,
    pub lineage: LineageGraph,
    pub gates: HardGates,
    pub cfg: GeneratorConfig,
}

impl Runtime {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        constitution: Constitution,
        parent: Genome,
        parent_detector: Detector,
        builder: SigningAuthority,
        judge_a: SigningAuthority,
        judge_b: SigningAuthority,
        controller: SigningAuthority,
        corpus: Corpus,
    ) -> Self {
        let gates = constitution.hard_gates;
        Runtime {
            constitution,
            parent,
            parent_detector,
            builder,
            judge_a,
            judge_b,
            controller,
            corpus,
            lineage: LineageGraph::new(),
            gates,
            cfg: GeneratorConfig::default(),
        }
    }

    /// Full observe→generate→**judge-sign**→**verify_promotion**→select loop.
    pub fn defend<C: Clock>(&mut self, evidence: &AttackEvidence, clock: &C) -> DefenseOutcome {
        let t0 = clock.now_millis();
        let now = clock.now_secs();
        let population = propose(evidence, &self.parent.hash, &self.builder, now, &self.cfg);

        let genome_payload = content_hash(&self.parent.hash);
        let root_id = self
            .lineage
            .append(Node::new(NodeKind::Genome, vec![], &genome_payload, None))
            .unwrap_or_default();
        let mut lineage_ids = vec![root_id.clone()];

        let parent_hash = content_hash(&self.parent.hash);
        let mut promotable = 0usize;
        let mut best: Option<ScoredCandidate> = None;

        for cand in &population {
            let mutation = match &cand.antibody.proposed_mutation {
                Some(m) => m.clone(),
                None => continue,
            };
            // A content-addressed capability-analysis proof ARTIFACT per preserved
            // invariant, recording the exact facts the analysis examined (this
            // mutation's authority + scope, the parent ceiling). The manifest
            // proof references the artifact by content hash; `verify_promotion`
            // resolves it and independently re-derives that it establishes the
            // invariant (finding #4 — no bare reference, no self-assertion).
            let mut proof_artifacts: Vec<ProofArtifact> = Vec::new();
            let proofs: Vec<InvariantProof> = self
                .parent
                .hard_invariants
                .iter()
                .filter(|i| i.holds)
                .map(|i| {
                    let artifact = ProofArtifact {
                        invariant: i.name.clone(),
                        kind: "capability_analysis".into(),
                        examined_authority: mutation.requested_authority,
                        examined_scope: mutation.scope,
                        parent_ceiling: self.parent.capability_ceiling,
                    };
                    let reference = artifact.reference();
                    proof_artifacts.push(artifact);
                    InvariantProof {
                        invariant: i.name.clone(),
                        kind: "capability_analysis".into(),
                        reference,
                    }
                })
                .collect();

            let manifest = CandidateManifest::from_parts(
                mutation,
                &cand.antibody.detector,
                Vec::new(), // no prohibited effects — retrieval rerank only
                Vec::new(),
                proofs,
            );
            let cand_hash = manifest.candidate_hash();

            // Two DISTINCT pinned judges measure candidate-vs-parent and sign.
            let r1 = evaluate_and_sign(
                &self.judge_a,
                &cand_hash,
                &parent_hash,
                &cand.antibody.detector,
                &self.parent_detector,
                &self.corpus,
                "corpus-v1",
                "eval-1",
                1.5,
                now,
            );
            let r2 = evaluate_and_sign(
                &self.judge_b,
                &cand_hash,
                &parent_hash,
                &cand.antibody.detector,
                &self.parent_detector,
                &self.corpus,
                "corpus-v1",
                "eval-1",
                1.6,
                now,
            );
            let receipts = vec![r1, r2];

            let env = PromotionEnvelope::signed(
                &self.controller,
                &self.constitution.hash(),
                &cand_hash,
                &receipts,
                &format!("nonce:{}:{}", evidence.trace_id, cand.niche),
                now,
                600,
            );

            // The closed check now MINTS the single-use promotion artifact on
            // success (ADR-403 item 1). If verification rejects, there is no
            // artifact and therefore no way to promote this candidate.
            let promotion = match verify_promotion_artifact(
                &self.constitution,
                &self.parent,
                &manifest,
                &receipts,
                &env,
                &proof_artifacts,
                now,
            ) {
                Ok(vp) => vp,
                Err(_) => continue, // not cryptographically admissible — no lineage, no promotion
            };
            promotable += 1;

            // Signed lineage: mutation ← genome, antibody ← mutation.
            let mut_payload = content_hash(&manifest.mutation.id);
            let mnode = Node::new(
                NodeKind::Mutation,
                vec![root_id.clone()],
                &mut_payload,
                Some(self.builder.seal(&mut_payload)),
            );
            if let Ok(mid) = self.lineage.append(mnode) {
                lineage_ids.push(mid.clone());
                let ab_payload = content_hash(&cand.antibody.id);
                let anode = Node::new(
                    NodeKind::Antibody,
                    vec![mid],
                    &ab_payload,
                    Some(self.controller.seal(&ab_payload)),
                );
                if let Ok(aid) = self.lineage.append(anode) {
                    lineage_ids.push(aid);
                }
            }

            let recall = receipts[0].candidate_recall;
            let fp = receipts[0].candidate_fp;
            let take = best
                .as_ref()
                .map(|b| recall > b.recall || (recall == b.recall && fp < b.fp))
                .unwrap_or(true);
            if take {
                best = Some(ScoredCandidate {
                    niche: cand.niche,
                    antibody: cand.antibody.clone(),
                    recall,
                    fp,
                    envelope: env,
                    receipts,
                    promotion,
                });
            }
        }

        DefenseOutcome {
            population: population.len(),
            promotable,
            chosen: best,
            elapsed_ms: clock.now_millis().saturating_sub(t0),
            lineage_ids,
        }
    }

    /// Drive a verified defense through the staged canary against a live fitness
    /// feed, measuring rollback/restore latency when a regression appears. The
    /// cryptographic promotion authority is the (already-verified) envelope; this
    /// is the staged rollout + timed rollback safety net.
    #[allow(clippy::too_many_arguments)]
    pub fn run_canary<C: Clock, F: FnMut(&C) -> FitnessVector, A: DeploymentAdapter>(
        &self,
        promotion: &VerifiedPromotion,
        clock: &C,
        adapter: &mut A,
        next_fitness: F,
        observations_per_stage: u32,
        max_samples: usize,
        slos: Slos,
        // Optional durable promotion ledger (ADR-403 item 4). When present, a
        // nonce already committed here is refused BEFORE promoting — durable,
        // cross-restart, cross-controller replay protection — and a fresh
        // promotion is recorded (fsync'd) so it survives a restart.
        ledger: Option<&mut PromotionLedger>,
    ) -> CanaryOutcome {
        // The controller's identity is bound to the verified artifact: it can
        // only finalize by consuming exactly this promotion (ADR-403 item 1).
        let mut ctrl = CanaryController::new(
            promotion.candidate_hash(),
            promotion.rollback_target(),
            self.gates,
            observations_per_stage,
        );
        self.drive_canary(
            &mut ctrl,
            promotion,
            clock,
            adapter,
            next_fitness,
            max_samples,
            slos,
            ledger,
            None,
        )
    }

    /// `run_canary` with a **durable mid-rollout checkpoint** (ADR-403 item 4). The
    /// controller's state is snapshotted (fsync'd) after every observation and
    /// reloaded on entry, so a crash at, say, the 50 % stage **resumes** there
    /// rather than restarting from 1 %. If `checkpoint_path` holds a snapshot it is
    /// restored (the `promotion`/`observations_per_stage` args then only seed a
    /// fresh controller when no snapshot exists). On a terminal outcome (promoted
    /// or rolled back) the checkpoint is cleared.
    #[allow(clippy::too_many_arguments)]
    pub fn run_canary_checkpointed<
        C: Clock,
        F: FnMut(&C) -> FitnessVector,
        A: DeploymentAdapter,
    >(
        &self,
        checkpoint_path: &Path,
        promotion: &VerifiedPromotion,
        clock: &C,
        adapter: &mut A,
        next_fitness: F,
        observations_per_stage: u32,
        max_samples: usize,
        slos: Slos,
        ledger: Option<&mut PromotionLedger>,
    ) -> CanaryOutcome {
        let mut ctrl: CanaryController = Checkpoint::load(checkpoint_path).unwrap_or_else(|| {
            CanaryController::new(
                promotion.candidate_hash(),
                promotion.rollback_target(),
                self.gates,
                observations_per_stage,
            )
        });
        let outcome = self.drive_canary(
            &mut ctrl,
            promotion,
            clock,
            adapter,
            next_fitness,
            max_samples,
            slos,
            ledger,
            Some(checkpoint_path),
        );
        if outcome.promoted || outcome.rolled_back {
            let _ = Checkpoint::clear(checkpoint_path);
        }
        outcome
    }

    /// The shared canary-driving loop. Operates on a caller-provided controller
    /// (fresh or restored from a checkpoint). When `checkpoint` is `Some`, the
    /// controller state is durably snapshotted after every observation.
    #[allow(clippy::too_many_arguments)]
    fn drive_canary<C: Clock, F: FnMut(&C) -> FitnessVector, A: DeploymentAdapter>(
        &self,
        ctrl: &mut CanaryController,
        promotion: &VerifiedPromotion,
        clock: &C,
        adapter: &mut A,
        mut next_fitness: F,
        max_samples: usize,
        slos: Slos,
        mut ledger: Option<&mut PromotionLedger>,
        checkpoint: Option<&Path>,
    ) -> CanaryOutcome {
        let rollback_target = promotion.rollback_target();
        let mut promoted = false;
        let mut rolled_back = false;
        let mut rollback_init_ms = None;
        let mut parent_restore_ms = None;
        let mut rollback_receipt = None;

        for _ in 0..max_samples {
            let f = next_fitness(clock);
            let before = clock.now_millis();
            let decision = ctrl.observe(&f);
            // Snapshot AFTER applying the observation, so a crash resumes from the
            // last durably-recorded stage (durability barrier per step).
            if let Some(path) = checkpoint {
                let _ = Checkpoint::save(path, &*ctrl);
            }
            match decision {
                Decision::RollBack { .. } => {
                    rollback_init_ms = Some(clock.now_millis().saturating_sub(before));
                    // Finding #6: actually COMMAND the restoration and confirm it —
                    // the adapter restores traffic to `rollback_target`, we verify
                    // the active artifact hash + health, and only a confirmed,
                    // healthy restore yields a signed receipt. A failed/unhealthy
                    // restore leaves `rolled_back = false` and fails `slos_met`.
                    let restore_start = clock.now_millis();
                    let receipt = verified_rollback(
                        adapter,
                        &self.controller,
                        rollback_target,
                        clock.now_secs(),
                    );
                    parent_restore_ms = Some(clock.now_millis().saturating_sub(restore_start));
                    if let Ok(r) = receipt {
                        if r.is_valid() {
                            rolled_back = true;
                            rollback_receipt = Some(r);
                        }
                    }
                    break;
                }
                Decision::ReadyForPromotion => {
                    // Durable replay guard: a nonce already committed to the
                    // ledger is refused even by a fresh controller after a restart.
                    let already = ledger
                        .as_ref()
                        .map(|l| l.contains_nonce(promotion.nonce()))
                        .unwrap_or(false);
                    if !already && ctrl.promote(promotion, clock.now_secs()).is_ok() {
                        promoted = true;
                        if let Some(l) = ledger.as_mut() {
                            let _ = l.record_promotion(
                                &self.controller,
                                PromotionRecord {
                                    candidate_hash: promotion.candidate_hash().into(),
                                    parent_hash: promotion.parent_hash().into(),
                                    corpus_id: promotion.corpus_id().into(),
                                    nonce: promotion.nonce().into(),
                                    controller_pubkey: promotion.controller_pubkey().into(),
                                },
                                clock.now_secs(),
                            );
                        }
                    }
                    break;
                }
                _ => {}
            }
        }

        let slos_met = match (rollback_init_ms, parent_restore_ms) {
            (Some(ri), Some(pr)) => {
                ri <= slos.max_rollback_init_ms
                    && pr <= slos.max_parent_restore_ms
                    // a rollback is only "met" if it was actually confirmed.
                    && rollback_receipt.as_ref().map(|r| r.is_valid()).unwrap_or(false)
            }
            _ => true,
        };
        CanaryOutcome {
            promoted,
            rolled_back,
            rollback_init_ms,
            parent_restore_ms,
            rollback_receipt,
            slos_met,
        }
    }

    /// `run_canary` fenced by a per-target promotion lock (ADR-403 item 2). The
    /// lock target is the artifact this promotion supersedes (`rollback_target`),
    /// so two candidates cannot concurrently roll out over the same parent and
    /// race to flip its traffic. If the target is already locked this returns
    /// `fenced` without running; otherwise it holds the guard for the entire
    /// rollout and releases it on return (or on any early exit / panic).
    #[allow(clippy::too_many_arguments)]
    pub fn run_canary_guarded<C: Clock, F: FnMut(&C) -> FitnessVector, A: DeploymentAdapter>(
        &self,
        lock: &PromotionLockRegistry,
        promotion: &VerifiedPromotion,
        clock: &C,
        adapter: &mut A,
        next_fitness: F,
        observations_per_stage: u32,
        max_samples: usize,
        slos: Slos,
        ledger: Option<&mut PromotionLedger>,
    ) -> GuardedCanary {
        let _guard: PromotionGuard = match lock.acquire(promotion.rollback_target()) {
            Some(g) => g,
            None => {
                return GuardedCanary {
                    fenced: true,
                    outcome: None,
                }
            }
        };
        let outcome = self.run_canary(
            promotion,
            clock,
            adapter,
            next_fitness,
            observations_per_stage,
            max_samples,
            slos,
            ledger,
        );
        // _guard drops here, releasing the target for the next rollout.
        GuardedCanary {
            fenced: false,
            outcome: Some(outcome),
        }
    }

    /// The **fully-guarded** promotion path (ADR-403): the single supported entry
    /// point that composes all three protections at once —
    /// - a per-target promotion **lock** (item 2, fences a concurrent rollout to
    ///   the same parent — returns `fenced` without running if held),
    /// - a durable promotion **ledger** (item 4, cross-restart replay protection +
    ///   the signed authorized-state record), and
    /// - a mid-rollout **checkpoint** (item 4, resume from the last durable stage
    ///   after a crash instead of restarting).
    ///
    /// Prefer this over the à-la-carte `run_canary{,_guarded,_checkpointed}`
    /// variants in production: those exist for tests and for callers that
    /// deliberately want a subset. Any callable `promote` bypass is a lower-level
    /// primitive — the durable + fenced guarantees live here, at the layer that
    /// holds the controller signing authority.
    #[allow(clippy::too_many_arguments)]
    pub fn run_canary_full<C: Clock, F: FnMut(&C) -> FitnessVector, A: DeploymentAdapter>(
        &self,
        lock: &PromotionLockRegistry,
        checkpoint_path: &Path,
        promotion: &VerifiedPromotion,
        clock: &C,
        adapter: &mut A,
        next_fitness: F,
        observations_per_stage: u32,
        max_samples: usize,
        slos: Slos,
        ledger: Option<&mut PromotionLedger>,
    ) -> GuardedCanary {
        let _guard: PromotionGuard = match lock.acquire(promotion.rollback_target()) {
            Some(g) => g,
            None => {
                return GuardedCanary {
                    fenced: true,
                    outcome: None,
                }
            }
        };
        // Held the lock for the whole rollout; checkpointed + ledger-guarded inside.
        let outcome = self.run_canary_checkpointed(
            checkpoint_path,
            promotion,
            clock,
            adapter,
            next_fitness,
            observations_per_stage,
            max_samples,
            slos,
            ledger,
        );
        GuardedCanary {
            fenced: false,
            outcome: Some(outcome),
        }
    }
}

#[cfg(test)]
mod system_clock_tests {
    use super::{Clock, SystemClock};

    // P0 fix (external review): the production clock must be Unix wall time, not a
    // fixed 1_800_000_000 (Jan 2027) base plus process uptime.
    #[test]
    fn system_clock_is_unix_wall_time_not_a_fixed_epoch() {
        let c = SystemClock;
        let secs = c.now_secs();
        assert!(secs > 1_750_000_000, "now_secs {secs} is implausibly early");
        assert!(
            secs < 2_050_000_000,
            "now_secs {secs} is implausibly late (fixed-epoch bug?)"
        );
        let millis = c.now_millis();
        assert!(
            (millis / 1000).abs_diff(u128::from(secs)) <= 1,
            "now_millis and now_secs disagree: {millis}ms vs {secs}s",
        );
    }
}
