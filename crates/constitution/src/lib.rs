//! # constitution — the immutable plane (ADR-392 §4.1, Phase 1)
//!
//! The constitution defines identity, authority ceilings, prohibited effects,
//! hard gates, signing policy, and shutdown. It is **externally governed**:
//! nothing in the evolutionary system may mutate it. Immutability is enforced
//! by content-hash pinning — every genome carries `constitution: <hash>`, and
//! the verifier refuses any artifact whose pinned hash does not match the
//! deployed constitution's recomputed hash.
//!
//! Constitutional *changes* happen outside the runtime: a new constitution
//! document, multiple signatures, an effective time, and a migration path
//! (ADR-392 §4.1) — modeled here as [`ConstitutionChange`], which this crate
//! can *represent and check* but never *apply*.

use agl_types::{Authority, HardGates};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The constitutional document. All fields are set at authoring time and never
/// mutated in place — the runtime holds it behind an immutable reference and
/// trusts only its content hash.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Constitution {
    pub identity: String,
    pub version: u32,
    /// The absolute authority ceiling for every genome under this constitution.
    pub authority_ceiling: Authority,
    /// Effects no mutation may ever produce (matched by name by the verifier).
    pub prohibited_effects: Vec<String>,
    /// Immutable promotion gates (min safety/governance, max FP/latency).
    pub hard_gates: HardGates,
    /// Identities whose signatures constitutional changes require (≥2 must sign).
    pub signers: Vec<String>,
    /// Unix seconds this document became effective.
    pub effective_at: u64,
}

impl Constitution {
    /// Canonical content hash (SHA-256 over canonical JSON). Genomes pin this.
    pub fn hash(&self) -> String {
        let canon = serde_json::to_vec(self).expect("constitution serializes");
        let mut h = Sha256::new();
        h.update(&canon);
        hex(&h.finalize())
    }

    /// Is `effect` constitutionally prohibited?
    pub fn prohibits(&self, effect: &str) -> bool {
        self.prohibited_effects.iter().any(|e| e == effect)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A proposed constitutional change — representable, checkable, and **never
/// applicable by this crate**. Application is an external, human act.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConstitutionChange {
    pub current_hash: String,
    pub proposed: Constitution,
    /// Signatures over the proposed document, by signer identity.
    pub signatures: Vec<(String, String)>,
    pub effective_at: u64,
    pub migration_path: String,
}

/// Why a constitutional change is not acceptable (yet).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangeError {
    StaleBase,
    InsufficientSignatures { have: usize, need: usize },
    UnknownSigner(String),
    NoMigrationPath,
}

impl ConstitutionChange {
    /// Check a change against the current constitution. Requires ≥2 known
    /// signers and a migration path (ADR-392 §4.1). Note: signature *presence*
    /// is checked structurally; cryptographic verification belongs to the
    /// external signing infrastructure, not the runtime.
    pub fn check(&self, current: &Constitution) -> Result<(), ChangeError> {
        if self.current_hash != current.hash() {
            return Err(ChangeError::StaleBase);
        }
        if self.migration_path.trim().is_empty() {
            return Err(ChangeError::NoMigrationPath);
        }
        let mut valid = 0usize;
        for (who, _sig) in &self.signatures {
            if current.signers.iter().any(|s| s == who) {
                valid += 1;
            } else {
                return Err(ChangeError::UnknownSigner(who.clone()));
            }
        }
        if valid < 2 {
            return Err(ChangeError::InsufficientSignatures { have: valid, need: 2 });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn test_constitution() -> Constitution {
        Constitution {
            identity: "autogenous-test".into(),
            version: 1,
            authority_ceiling: Authority::Governed,
            prohibited_effects: vec!["filesystem_write".into(), "pii_egress".into()],
            hard_gates: HardGates::default(),
            signers: vec!["alice".into(), "bob".into(), "carol".into()],
            effective_at: 1_700_000_000,
        }
    }

    #[test]
    fn hash_is_stable_and_content_sensitive() {
        let c = test_constitution();
        assert_eq!(c.hash(), c.hash());
        let mut c2 = c.clone();
        c2.version = 2;
        assert_ne!(c.hash(), c2.hash());
    }

    #[test]
    fn prohibited_effects_are_matched() {
        let c = test_constitution();
        assert!(c.prohibits("pii_egress"));
        assert!(!c.prohibits("cache_update"));
    }

    #[test]
    fn change_requires_two_known_signers_and_migration() {
        let c = test_constitution();
        let mut proposed = c.clone();
        proposed.version = 2;
        let mut ch = ConstitutionChange {
            current_hash: c.hash(),
            proposed,
            signatures: vec![("alice".into(), "s1".into())],
            effective_at: 1_800_000_000,
            migration_path: "docs/migrations/v2.md".into(),
        };
        assert_eq!(ch.check(&c), Err(ChangeError::InsufficientSignatures { have: 1, need: 2 }));
        ch.signatures.push(("bob".into(), "s2".into()));
        assert_eq!(ch.check(&c), Ok(()));
        ch.signatures.push(("mallory".into(), "s3".into()));
        assert_eq!(ch.check(&c), Err(ChangeError::UnknownSigner("mallory".into())));
    }

    #[test]
    fn stale_base_is_refused() {
        let c = test_constitution();
        let ch = ConstitutionChange {
            current_hash: "not-the-hash".into(),
            proposed: c.clone(),
            signatures: vec![("alice".into(), "s".into()), ("bob".into(), "s".into())],
            effective_at: 0,
            migration_path: "m".into(),
        };
        assert_eq!(ch.check(&c), Err(ChangeError::StaleBase));
    }
}
