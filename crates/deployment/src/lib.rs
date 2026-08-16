//! # deployment — two-phase **verified** rollback (review finding #6)
//!
//! The review's objection: "rollback is represented, not verified or executed …
//! the controller only changes internal state and writes an audit string." This
//! crate makes rollback a real, confirmed transition:
//!
//! 1. **Request** restoration of a target artifact through an idempotent adapter.
//! 2. **Confirm** the restored artifact hash **and** its health.
//! 3. **Emit a signed rollback receipt.**
//! 4. Only then is the candidate terminal.
//!
//! The [`DeploymentAdapter`] trait is the seam a real router/orchestrator (or an
//! RVM/RVF-backed runtime) implements; [`InMemoryAdapter`] is the deterministic
//! reference used by tests and the demo. Nothing here trusts a boolean — the
//! restore is confirmed against the adapter's actually-active artifact and its
//! reported health, and sealed by an ed25519 receipt.

use serde::{Deserialize, Serialize};
use witness::{SigningAuthority, WitnessSeal};

/// Reported health of the currently-active artifact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Healthy,
    Degraded,
    Unknown,
}

/// Why a deploy/restore could not be confirmed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeployError {
    /// The requested artifact hash is not known to the adapter.
    UnknownArtifact(String),
    /// After the request, the active artifact is not the requested one.
    NotActivated { want: String, got: String },
    /// The restored artifact is active but not healthy.
    NotHealthy(Health),
}

/// The signed proof that a rollback actually happened and was confirmed healthy.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RollbackReceipt {
    pub restored_hash: String,
    pub confirmed_health: Health,
    pub timestamp: u64,
    /// ed25519 seal over `restored_hash` by the controller authority.
    pub seal: WitnessSeal,
}

impl RollbackReceipt {
    /// True iff the seal verifies, it binds the restored hash, and health is Healthy.
    pub fn is_valid(&self) -> bool {
        self.confirmed_health == Health::Healthy
            && self.seal.subject_hash == self.restored_hash
            && witness::verify_seal(&self.seal)
    }
}

/// The seam a real deployment surface implements.
pub trait DeploymentAdapter {
    /// The artifact hash currently receiving traffic.
    fn active(&self) -> String;
    /// Health of the active artifact.
    fn health(&self) -> Health;
    /// Route traffic to `artifact_hash`. Idempotent. Fails if unknown.
    fn deploy(&mut self, artifact_hash: &str) -> Result<(), DeployError>;
    /// Restore `target_hash` (the parent). Idempotent. Fails if unknown.
    fn restore(&mut self, target_hash: &str) -> Result<(), DeployError>;
}

/// Command a **verified** rollback through `adapter`, sealing it with `controller`.
/// Two-phase: request restore, then confirm the active artifact IS the target and
/// is healthy — only a confirmed, healthy restore yields a receipt.
pub fn verified_rollback<A: DeploymentAdapter>(
    adapter: &mut A,
    controller: &SigningAuthority,
    target_hash: &str,
    now: u64,
) -> Result<RollbackReceipt, DeployError> {
    // Phase 1: request.
    adapter.restore(target_hash)?;
    // Phase 2: confirm the active artifact hash…
    let active = adapter.active();
    if active != target_hash {
        return Err(DeployError::NotActivated {
            want: target_hash.to_string(),
            got: active,
        });
    }
    // …and its health.
    let health = adapter.health();
    if health != Health::Healthy {
        return Err(DeployError::NotHealthy(health));
    }
    // Phase 3: sealed receipt.
    Ok(RollbackReceipt {
        restored_hash: target_hash.to_string(),
        confirmed_health: health,
        timestamp: now,
        seal: controller.seal(target_hash),
    })
}

/// Deterministic in-memory reference adapter for tests and the demo.
#[derive(Clone, Debug, Default)]
pub struct InMemoryAdapter {
    active: String,
    /// Known artifacts and their health.
    catalog: std::collections::BTreeMap<String, Health>,
}

impl InMemoryAdapter {
    /// Start with `initial` active (registered Healthy).
    pub fn new(initial: &str) -> Self {
        let mut catalog = std::collections::BTreeMap::new();
        catalog.insert(initial.to_string(), Health::Healthy);
        InMemoryAdapter {
            active: initial.to_string(),
            catalog,
        }
    }
    /// Register an artifact with a known health (e.g. a candidate before deploy).
    pub fn register(&mut self, hash: &str, health: Health) {
        self.catalog.insert(hash.to_string(), health);
    }
}

impl DeploymentAdapter for InMemoryAdapter {
    fn active(&self) -> String {
        self.active.clone()
    }
    fn health(&self) -> Health {
        self.catalog
            .get(&self.active)
            .copied()
            .unwrap_or(Health::Unknown)
    }
    fn deploy(&mut self, artifact_hash: &str) -> Result<(), DeployError> {
        if !self.catalog.contains_key(artifact_hash) {
            return Err(DeployError::UnknownArtifact(artifact_hash.to_string()));
        }
        self.active = artifact_hash.to_string();
        Ok(())
    }
    fn restore(&mut self, target_hash: &str) -> Result<(), DeployError> {
        if !self.catalog.contains_key(target_hash) {
            return Err(DeployError::UnknownArtifact(target_hash.to_string()));
        }
        self.active = target_hash.to_string();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_rollback_restores_confirms_and_seals() {
        let controller = SigningAuthority::from_seed("controller", [7u8; 32]);
        let mut a = InMemoryAdapter::new("parent-artifact");
        a.register("candidate-artifact", Health::Healthy);
        a.deploy("candidate-artifact").unwrap();
        assert_eq!(a.active(), "candidate-artifact");

        let receipt =
            verified_rollback(&mut a, &controller, "parent-artifact", 1_800_000_000).unwrap();
        assert_eq!(a.active(), "parent-artifact", "traffic actually restored");
        assert!(
            receipt.is_valid(),
            "receipt must verify + bind restored hash + be healthy"
        );
        assert_eq!(receipt.restored_hash, "parent-artifact");
    }

    #[test]
    fn restoring_an_unknown_target_fails_no_receipt() {
        let controller = SigningAuthority::from_seed("c", [1u8; 32]);
        let mut a = InMemoryAdapter::new("parent");
        let r = verified_rollback(&mut a, &controller, "ghost-parent", 0);
        assert!(matches!(r, Err(DeployError::UnknownArtifact(ref h)) if h == "ghost-parent"));
    }

    #[test]
    fn a_degraded_parent_is_not_confirmed() {
        // Restoration that reaches the target but is unhealthy must NOT produce a
        // valid rollback — it escalates instead of silently "succeeding".
        let controller = SigningAuthority::from_seed("c", [2u8; 32]);
        let mut a = InMemoryAdapter::new("candidate");
        a.register("parent", Health::Degraded);
        let r = verified_rollback(&mut a, &controller, "parent", 0);
        assert!(matches!(r, Err(DeployError::NotHealthy(Health::Degraded))));
        assert_eq!(
            a.active(),
            "parent",
            "traffic moved, but rollback is not confirmed"
        );
    }

    #[test]
    fn a_forged_receipt_does_not_validate() {
        let controller = SigningAuthority::from_seed("c", [3u8; 32]);
        let mut a = InMemoryAdapter::new("parent");
        let mut receipt = verified_rollback(&mut a, &controller, "parent", 0).unwrap();
        receipt.restored_hash = "something-else".into(); // seal no longer binds it
        assert!(!receipt.is_valid());
    }
}
