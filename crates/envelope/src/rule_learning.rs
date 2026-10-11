//! Opt-in evidence gate. No generated program is executed here. Independent
//! pinned judges must measure the artifacts and sign the enclosing receipt.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const CAPABILITY: &str = "verified_rule_learning_v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FamilyEvidence {
    pub id: String,
    pub seeds: Vec<u64>,
    pub samples: u64,
    pub parent_successes: u64,
    pub candidate_successes: u64,
    pub parent_interactions: u64,
    pub candidate_interactions: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleLearningEvidence {
    pub schema: String,
    pub run_id: String,
    pub candidate_hash: String,
    pub parent_hash: String,
    pub rulebook_hash: String,
    pub executable_hash: String,
    pub trace_hash: String,
    pub hidden_corpus_hash: String,
    pub families: Vec<FamilyEvidence>,
    pub replay_steps: u64,
    pub replay_mismatches: u64,
    pub independent_probes: u64,
    pub failed_probes: u64,
}

impl RuleLearningEvidence {
    pub fn validate(
        &self,
        candidate: &str,
        parent: &str,
        corpus: &str,
        nonce: &str,
    ) -> Result<(), String> {
        let fail = |s: &str| Err(s.to_string());
        if self.schema != "rule-learning-evidence/v1" {
            return fail("unknown evidence schema");
        }
        if self.run_id.is_empty()
            || self.run_id.len() > 128
            || self.run_id != nonce
            || self.candidate_hash != candidate
            || self.parent_hash != parent
            || self.hidden_corpus_hash != corpus
        {
            return fail("evidence binding mismatch");
        }
        for hash in [
            &self.candidate_hash,
            &self.parent_hash,
            &self.rulebook_hash,
            &self.executable_hash,
            &self.trace_hash,
            &self.hidden_corpus_hash,
        ] {
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return fail("invalid artifact hash");
            }
        }
        if self.replay_steps == 0
            || self.replay_mismatches != 0
            || self.independent_probes == 0
            || self.failed_probes != 0
        {
            return fail("replay or independent probe failure");
        }
        if self.families.len() != 3 {
            return fail("three task families required");
        }
        let mut ids = BTreeSet::new();
        let (mut wins, mut parent_cost, mut candidate_cost) = (0, 0u128, 0u128);
        for f in &self.families {
            if f.id.is_empty()
                || f.id.len() > 128
                || !ids.insert(&f.id)
                || f.seeds.len() != 5
                || f.seeds.iter().collect::<BTreeSet<_>>().len() != 5
                || f.seeds.iter().collect::<BTreeSet<_>>()
                    != self.families[0].seeds.iter().collect::<BTreeSet<_>>()
                || f.samples < 5
                || f.parent_successes > f.samples
                || f.candidate_successes > f.samples
                || f.parent_interactions == 0
                || f.candidate_interactions == 0
            {
                return fail("invalid family coverage or counts");
            }
            let gain = i128::from(f.candidate_successes) - i128::from(f.parent_successes);
            if gain < 0 {
                return fail("family regression");
            }
            if gain * 100 >= i128::from(f.samples) * 20 {
                wins += 1;
            }
            parent_cost += u128::from(f.parent_interactions);
            candidate_cost += u128::from(f.candidate_interactions);
        }
        if wins < 2 {
            return fail("20 percentage point gain required on two families");
        }
        if candidate_cost * 4 > parent_cost * 3 {
            return fail("25 percent interaction reduction required");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn evidence() -> RuleLearningEvidence {
        RuleLearningEvidence {
            schema: "rule-learning-evidence/v1".into(),
            run_id: "run".into(),
            candidate_hash: "e".repeat(64),
            parent_hash: "f".repeat(64),
            rulebook_hash: "a".repeat(64),
            executable_hash: "b".repeat(64),
            trace_hash: "c".repeat(64),
            hidden_corpus_hash: "d".repeat(64),
            families: (0..3)
                .map(|i| FamilyEvidence {
                    id: i.to_string(),
                    seeds: vec![0, 1, 2, 3, 4],
                    samples: 100,
                    parent_successes: 50,
                    candidate_successes: 70,
                    parent_interactions: 100,
                    candidate_interactions: 75,
                })
                .collect(),
            replay_steps: 100,
            replay_mismatches: 0,
            independent_probes: 15,
            failed_probes: 0,
        }
    }
    fn check(e: &RuleLearningEvidence) -> Result<(), String> {
        e.validate(&"e".repeat(64), &"f".repeat(64), &"d".repeat(64), "run")
    }
    #[test]
    fn exact_boundaries_pass() {
        assert!(check(&evidence()).is_ok());
    }
    #[test]
    fn fail_closed_matrix() {
        let mutations: Vec<Box<dyn Fn(&mut RuleLearningEvidence)>> = vec![
            Box::new(|e| e.run_id = "old-run".into()),
            Box::new(|e| e.candidate_hash = "other".into()),
            Box::new(|e| e.parent_hash = "ancestor".into()),
            Box::new(|e| e.trace_hash.clear()),
            Box::new(|e| e.hidden_corpus_hash = "e".repeat(64)),
            Box::new(|e| e.replay_steps = 0),
            Box::new(|e| e.replay_mismatches = 1),
            Box::new(|e| e.failed_probes = 1),
            Box::new(|e| e.independent_probes = 0),
            Box::new(|e| e.families.pop().map(|_| ()).unwrap()),
            Box::new(|e| e.families[0].seeds[0] = 1),
            Box::new(|e| e.families[0].samples = 0),
            Box::new(|e| e.families[0].candidate_successes = 101),
            Box::new(|e| e.families[0].candidate_successes = 49),
            Box::new(|e| {
                e.families[0].candidate_successes = 69;
                e.families[1].candidate_successes = 69;
            }),
            Box::new(|e| e.families[0].candidate_interactions = 76),
        ];
        for change in mutations {
            let mut e = evidence();
            change(&mut e);
            assert!(check(&e).is_err());
        }
    }
    #[test]
    fn large_counts_do_not_overflow() {
        let mut e = evidence();
        for f in &mut e.families {
            f.samples = u64::MAX;
            f.parent_successes = 0;
            f.candidate_successes = u64::MAX;
            f.parent_interactions = u64::MAX;
            f.candidate_interactions = u64::MAX / 2;
        }
        assert!(check(&e).is_ok());
    }
}
