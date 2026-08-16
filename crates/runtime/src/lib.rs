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
pub use deployment::{DeploymentAdapter, Health, InMemoryAdapter, RollbackReceipt};
use envelope::{
    evaluate_and_sign, verify_promotion, CandidateManifest, EvaluationReceipt, InvariantProof,
    PromotionEnvelope, ProofArtifact, RolePins,
};
use evaluator::Corpus;
use generator::{propose, AttackEvidence, GeneratorConfig};
use lineage::{LineageGraph, Node, NodeKind};
use promotion::{CanaryController, Decision};
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

/// A real wall-clock (demo / production).
pub struct SystemClock {
    start: std::time::Instant,
}
impl Default for SystemClock {
    fn default() -> Self {
        SystemClock {
            start: std::time::Instant::now(),
        }
    }
}
impl Clock for SystemClock {
    fn now_millis(&self) -> u128 {
        self.start.elapsed().as_millis()
    }
    fn now_secs(&self) -> u64 {
        1_800_000_000 + self.start.elapsed().as_secs()
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
    pub pins: RolePins,
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
        let pins = RolePins {
            judges: vec![judge_a.public_hex(), judge_b.public_hex()],
            controllers: vec![controller.public_hex()],
        };
        Runtime {
            constitution,
            parent,
            parent_detector,
            builder,
            judge_a,
            judge_b,
            controller,
            corpus,
            pins,
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

            let rejects = verify_promotion(
                &self.constitution,
                &self.parent,
                &manifest,
                &receipts,
                &env,
                &self.pins,
                &proof_artifacts,
                now,
            );
            if !rejects.is_empty() {
                continue; // not cryptographically admissible — no lineage, no promotion
            }
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
        candidate_id: &str,
        rollback_target: &str,
        clock: &C,
        adapter: &mut A,
        mut next_fitness: F,
        observations_per_stage: u32,
        max_samples: usize,
        slos: Slos,
    ) -> CanaryOutcome {
        let mut ctrl = CanaryController::new(
            candidate_id,
            rollback_target,
            self.gates,
            observations_per_stage,
        );
        let mut promoted = false;
        let mut rolled_back = false;
        let mut rollback_init_ms = None;
        let mut parent_restore_ms = None;
        let mut rollback_receipt = None;

        for _ in 0..max_samples {
            let f = next_fitness(clock);
            let before = clock.now_millis();
            match ctrl.observe(&f) {
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
                    if ctrl
                        .promote(&self.controller.sign_hex(candidate_id.as_bytes()))
                        .is_ok()
                    {
                        promoted = true;
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
}
