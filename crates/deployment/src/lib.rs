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

/// A per-target promotion lock (ADR-403 item 2 — *fence concurrent promotions*).
///
/// At most one rollout may be in-flight to a given deployment target at a time,
/// so two candidates cannot race to flip the **same** target's traffic (a
/// split-brain where each thinks it won). It is thread-safe — a real orchestrator
/// runs rollouts concurrently — and a held target fails a second `acquire`
/// fast (fence, not block); distinct targets never contend. The guard releases
/// the lock on drop, so a rollout that panics or returns early cannot wedge the
/// target permanently.
#[derive(Clone, Default)]
pub struct PromotionLockRegistry {
    held: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
}

/// Proof of exclusive promotion rights to one target. Releases on drop.
#[must_use = "dropping the guard immediately releases the promotion lock"]
pub struct PromotionGuard {
    target: String,
    held: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
}

impl PromotionLockRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquire exclusive promotion rights to `target`. Returns `None` if another
    /// rollout already holds it (the caller must NOT promote to that target).
    pub fn acquire(&self, target: &str) -> Option<PromotionGuard> {
        let mut held = self.held.lock().expect("promotion lock poisoned");
        if held.contains(target) {
            return None;
        }
        held.insert(target.to_string());
        Some(PromotionGuard {
            target: target.to_string(),
            held: self.held.clone(),
        })
    }

    /// Is a rollout currently in-flight to `target`?
    pub fn is_locked(&self, target: &str) -> bool {
        self.held
            .lock()
            .expect("promotion lock poisoned")
            .contains(target)
    }
}

impl PromotionGuard {
    /// The target this guard fences.
    pub fn target(&self) -> &str {
        &self.target
    }
}

impl Drop for PromotionGuard {
    fn drop(&mut self) {
        if let Ok(mut held) = self.held.lock() {
            held.remove(&self.target);
        }
    }
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

    #[test]
    fn promotion_lock_fences_the_same_target_but_not_distinct_ones() {
        let reg = PromotionLockRegistry::new();
        let g = reg.acquire("service-A").expect("first acquire wins");
        assert!(reg.is_locked("service-A"));
        // A second rollout to the SAME target is fenced.
        assert!(reg.acquire("service-A").is_none());
        // A DIFFERENT target is independent.
        let g2 = reg.acquire("service-B").expect("distinct target free");
        assert_eq!(g.target(), "service-A");
        assert_eq!(g2.target(), "service-B");
        // Releasing A frees it for the next rollout.
        drop(g);
        assert!(!reg.is_locked("service-A"));
        let g3 = reg.acquire("service-A").expect("re-acquire after release");
        assert!(reg.is_locked("service-A") && reg.is_locked("service-B"));
        drop((g2, g3));
    }

    #[test]
    fn promotion_lock_is_mutually_exclusive_under_real_contention() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let reg = PromotionLockRegistry::new();
        let winners = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        // 16 threads race for the SAME target; exactly one may hold it at once.
        for _ in 0..16 {
            let reg = reg.clone();
            let winners = winners.clone();
            handles.push(std::thread::spawn(move || {
                for _ in 0..1000 {
                    if let Some(_guard) = reg.acquire("hot-target") {
                        // Inside the critical section: no one else may be here.
                        let prev = winners.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(prev, 0, "two rollouts held the same target at once");
                        winners.fetch_sub(1, Ordering::SeqCst);
                        // _guard drops here, releasing the target.
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        // All guards released → target free again.
        assert!(!reg.is_locked("hot-target"));
    }
}
