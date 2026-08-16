//! # witness — content addressing + ed25519 signing + append-only records
//!
//! Turns the placeholder `signature: "sig"` strings into real cryptography and
//! gives the evidence plane its **witness chain** (ADR-392 §4.5, §13).
//!
//! - **Content addressing**: [`content_hash`] = SHA-256 over the canonical JSON
//!   of any serializable artifact (genome, mutation, antibody, incident). Same
//!   bytes on every deployment → the same hash → lineage that reconciles.
//! - **Signing authorities**: [`SigningAuthority`] wraps an ed25519 key. The
//!   generator, evaluator, and promotion controller each hold a *separate*
//!   authority (ADR-392 §11) — signatures are attributable and non-forgeable.
//! - **Witness records**: [`WitnessRecord`] is an append-only, signed link in a
//!   chain — each record commits to the previous record's hash, so the history
//!   is tamper-evident and reconstructable for forensic replay.
//!
//! Verification is offline and deterministic: given a public key hex, message
//! bytes, and a signature hex, [`verify_hex`] never touches state or a clock.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// SHA-256 over the canonical JSON encoding of `value`, hex-encoded.
pub fn content_hash<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("serializable artifact");
    let mut h = Sha256::new();
    h.update(&bytes);
    hex(&h.finalize())
}

/// A separate signing authority (ADR-392 §11 — builders/judges/controllers each
/// hold their own). Constructed from a 32-byte seed so tests and deployments are
/// deterministic; production seeds come from a KMS/HSM, never from source.
pub struct SigningAuthority {
    pub id: String,
    key: SigningKey,
}

impl SigningAuthority {
    /// Deterministic authority from a labeled 32-byte seed.
    pub fn from_seed(id: &str, seed: [u8; 32]) -> Self {
        SigningAuthority {
            id: id.into(),
            key: SigningKey::from_bytes(&seed),
        }
    }

    /// The verifying (public) key, hex-encoded — the identity signatures are
    /// checked against.
    pub fn public_hex(&self) -> String {
        hex(self.key.verifying_key().as_bytes())
    }

    /// Detached signature over `msg`, hex-encoded.
    pub fn sign_hex(&self, msg: &[u8]) -> String {
        hex(&self.key.sign(msg).to_bytes())
    }
}

/// Verify a detached hex signature over `msg` by the given hex public key.
/// Returns `false` for any malformed input — never panics, never errors out to
/// the caller (a bad signature and a bad key are both "not verified").
pub fn verify_hex(pubkey_hex: &str, msg: &[u8], sig_hex: &str) -> bool {
    let (pk, sig) = match (unhex32(pubkey_hex), unhex64(sig_hex)) {
        (Some(pk), Some(sig)) => (pk, sig),
        _ => return false,
    };
    let vk = match VerifyingKey::from_bytes(&pk) {
        Ok(vk) => vk,
        Err(_) => return false,
    };
    vk.verify(msg, &Signature::from_bytes(&sig)).is_ok()
}

/// A detached seal binding an issuer to a subject content hash — the lightweight
/// per-artifact form (vs. the chained [`WitnessRecord`]). Used by the lineage
/// store to seal individual nodes.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WitnessSeal {
    pub subject_hash: String,
    pub issuer_pubkey: String,
    pub signature: String,
}

impl SigningAuthority {
    /// Seal a subject content hash.
    pub fn seal(&self, subject_hash: &str) -> WitnessSeal {
        WitnessSeal {
            subject_hash: subject_hash.to_string(),
            issuer_pubkey: self.public_hex(),
            signature: self.sign_hex(subject_hash.as_bytes()),
        }
    }
}

/// Verify a detached seal — malformed inputs return `false`, never panic.
pub fn verify_seal(seal: &WitnessSeal) -> bool {
    verify_hex(
        &seal.issuer_pubkey,
        seal.subject_hash.as_bytes(),
        &seal.signature,
    )
}

/// What a witness record attests to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Observation,
    Admission,
    Evaluation,
    Promotion,
    Rollback,
    Revocation,
}

/// An append-only, signed witness record (ADR-392 §4.5). The signature covers
/// every field *except* itself; `prev` links to the previous record's hash.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WitnessRecord {
    pub kind: RecordKind,
    /// Content hash of the artifact this record is about.
    pub subject_hash: String,
    pub issuer_pubkey: String,
    pub timestamp: u64,
    /// Hash of the previous record in the chain (None for the genesis record).
    pub prev: Option<String>,
    /// Detached signature over the canonical record-without-signature.
    #[serde(default)]
    pub signature: String,
}

impl WitnessRecord {
    /// Build and sign a record. `prev` is the hash of the last record (or None).
    pub fn signed(
        authority: &SigningAuthority,
        kind: RecordKind,
        subject_hash: &str,
        timestamp: u64,
        prev: Option<String>,
    ) -> Self {
        let mut rec = WitnessRecord {
            kind,
            subject_hash: subject_hash.into(),
            issuer_pubkey: authority.public_hex(),
            timestamp,
            prev,
            signature: String::new(),
        };
        let sig = authority.sign_hex(&rec.signing_bytes());
        rec.signature = sig;
        rec
    }

    /// Canonical bytes the signature covers (record with an empty signature).
    fn signing_bytes(&self) -> Vec<u8> {
        let mut unsigned = self.clone();
        unsigned.signature = String::new();
        serde_json::to_vec(&unsigned).expect("record serializes")
    }

    /// This record's own content hash (used as the next record's `prev`).
    pub fn hash(&self) -> String {
        content_hash(self)
    }

    /// Is this record's signature valid for its declared issuer?
    pub fn verify(&self) -> bool {
        !self.signature.is_empty()
            && verify_hex(&self.issuer_pubkey, &self.signing_bytes(), &self.signature)
    }
}

/// Verify a whole chain: every record's signature is valid AND each record's
/// `prev` equals the actual hash of the record before it. Returns the index of
/// the first bad record, or `Ok(())`.
pub fn verify_chain(records: &[WitnessRecord]) -> Result<(), usize> {
    let mut expected_prev: Option<String> = None;
    for (i, rec) in records.iter().enumerate() {
        if !rec.verify() {
            return Err(i);
        }
        if rec.prev != expected_prev {
            return Err(i);
        }
        expected_prev = Some(rec.hash());
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
fn unhex32(s: &str) -> Option<[u8; 32]> {
    unhex(s).and_then(|v| v.try_into().ok())
}
fn unhex64(s: &str) -> Option<[u8; 64]> {
    unhex(s).and_then(|v| <[u8; 64]>::try_from(v).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority(tag: u8) -> SigningAuthority {
        SigningAuthority::from_seed(&format!("auth-{tag}"), [tag; 32])
    }

    #[test]
    fn sign_verify_roundtrip_and_tamper_detection() {
        let a = authority(1);
        let msg = b"promote candidate m-42";
        let sig = a.sign_hex(msg);
        assert!(verify_hex(&a.public_hex(), msg, &sig));
        // tampered message
        assert!(!verify_hex(
            &a.public_hex(),
            b"promote candidate m-99",
            &sig
        ));
        // wrong key
        assert!(!verify_hex(&authority(2).public_hex(), msg, &sig));
        // malformed inputs never panic, just fail
        assert!(!verify_hex("zz", msg, &sig));
        assert!(!verify_hex(&a.public_hex(), msg, "short"));
    }

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        #[derive(Serialize)]
        struct T {
            a: u32,
            b: String,
        }
        let x = T {
            a: 1,
            b: "hi".into(),
        };
        assert_eq!(content_hash(&x), content_hash(&x));
        assert_ne!(
            content_hash(&x),
            content_hash(&T {
                a: 2,
                b: "hi".into()
            })
        );
    }

    #[test]
    fn witness_record_signs_and_verifies() {
        let a = authority(7);
        let rec = WitnessRecord::signed(
            &a,
            RecordKind::Promotion,
            "artifact-hash",
            1_800_000_000,
            None,
        );
        assert!(rec.verify());
        // mutate a field -> signature no longer valid
        let mut bad = rec.clone();
        bad.subject_hash = "different".into();
        assert!(!bad.verify());
    }

    #[test]
    fn chain_verifies_and_detects_breaks() {
        let obs = authority(1);
        let ctrl = authority(2); // separate authority for the promotion step
        let r0 = WitnessRecord::signed(&obs, RecordKind::Observation, "incident-1", 100, None);
        let r1 = WitnessRecord::signed(
            &obs,
            RecordKind::Admission,
            "mutation-1",
            101,
            Some(r0.hash()),
        );
        let r2 = WitnessRecord::signed(
            &ctrl,
            RecordKind::Promotion,
            "mutation-1",
            102,
            Some(r1.hash()),
        );
        assert_eq!(verify_chain(&[r0.clone(), r1.clone(), r2.clone()]), Ok(()));
        // reorder breaks the prev-link
        assert!(verify_chain(&[r0.clone(), r2.clone(), r1.clone()]).is_err());
        // forge a record inside the chain
        let mut forged = r1.clone();
        forged.subject_hash = "smuggled".into();
        assert_eq!(verify_chain(&[r0, forged, r2]), Err(1));
    }
}
