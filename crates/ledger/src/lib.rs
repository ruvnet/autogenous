//! # ledger — the durable promotion ledger (ADR-403 item 4)
//!
//! A promotion is single-use **within a process** once
//! [`promotion::CanaryController`] consumes its nonce (ADR-403 item 1). This crate
//! makes that guarantee survive a restart: an **append-only, fsync'd,
//! hash-chained** log of every promotion actually committed. It gives three
//! things the acceptance test needs —
//!
//! - **durable replay protection**: a nonce recorded here is rejected forever,
//!   across restarts and across controllers;
//! - **restart reconstruction**: reopening the ledger rebuilds the consumed-nonce
//!   set and the promoted-candidate history without manual edits;
//! - **tamper evidence**: each line commits (via [`witness::WitnessRecord`]) to
//!   its payload's content hash and links to the previous line's hash, so
//!   editing, forging, or reordering any line fails verification.
//!
//! The ledger records only *committed* promotions — it does not itself authorize;
//! it is the durable memory the authorization layer consults and appends to.

use std::collections::HashSet;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use witness::{content_hash, verify_chain, RecordKind, SigningAuthority, WitnessRecord};

/// The identity a promotion record binds — the same facts a
/// `VerifiedPromotion` carries, so the ledger line is provably about one exact
/// promotion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromotionRecord {
    pub candidate_hash: String,
    pub parent_hash: String,
    pub corpus_id: String,
    pub nonce: String,
    pub controller_pubkey: String,
}

/// One durable line: the signed chain record plus the payload it commits to.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub record: WitnessRecord,
    pub payload: PromotionRecord,
}

/// Why a ledger operation failed.
#[derive(Debug)]
pub enum LedgerError {
    Io(std::io::Error),
    /// The persisted chain failed signature/link verification at this index.
    CorruptChain(usize),
    /// A line's payload does not match the hash its record commits to.
    PayloadMismatch(usize),
    /// This nonce is already recorded — durable single-use (replay) guard.
    Replay(String),
    /// A stored line could not be parsed (index into the file).
    Parse(usize),
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LedgerError::Io(e) => write!(f, "ledger io error: {e}"),
            LedgerError::CorruptChain(i) => write!(f, "corrupt chain at record {i}"),
            LedgerError::PayloadMismatch(i) => {
                write!(f, "payload/record hash mismatch at line {i}")
            }
            LedgerError::Replay(n) => write!(f, "nonce already recorded (durable replay): {n}"),
            LedgerError::Parse(i) => write!(f, "unparseable ledger line {i}"),
        }
    }
}
impl std::error::Error for LedgerError {}
impl From<std::io::Error> for LedgerError {
    fn from(e: std::io::Error) -> Self {
        LedgerError::Io(e)
    }
}

/// An append-only durable ledger of committed promotions.
#[derive(Debug)]
pub struct PromotionLedger {
    path: PathBuf,
    entries: Vec<LedgerEntry>,
    nonces: HashSet<String>,
}

impl PromotionLedger {
    /// Open (or create) a ledger at `path`, replaying and **verifying** the whole
    /// persisted chain. A corrupt or tampered log is rejected here — a caller that
    /// gets `Ok` holds a ledger whose entire history has been cryptographically
    /// checked and whose nonce index is reconstructed.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, LedgerError> {
        let path = path.as_ref().to_path_buf();
        let mut entries = Vec::new();
        if path.exists() {
            let f = File::open(&path)?;
            for (i, line) in BufReader::new(f).lines().enumerate() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let entry: LedgerEntry =
                    serde_json::from_str(&line).map_err(|_| LedgerError::Parse(i))?;
                entries.push(entry);
            }
        }
        Self::from_entries(path, entries)
    }

    fn from_entries(path: PathBuf, entries: Vec<LedgerEntry>) -> Result<Self, LedgerError> {
        // (1) the signed record chain must verify (signatures + prev links).
        let records: Vec<WitnessRecord> = entries.iter().map(|e| e.record.clone()).collect();
        verify_chain(&records).map_err(LedgerError::CorruptChain)?;
        // (2) each payload must be the exact thing its record committed to, and
        //     no nonce may appear twice in the durable log.
        let mut nonces = HashSet::new();
        for (i, e) in entries.iter().enumerate() {
            if e.record.subject_hash != content_hash(&e.payload) {
                return Err(LedgerError::PayloadMismatch(i));
            }
            if !nonces.insert(e.payload.nonce.clone()) {
                return Err(LedgerError::Replay(e.payload.nonce.clone()));
            }
        }
        Ok(PromotionLedger {
            path,
            entries,
            nonces,
        })
    }

    /// Has this nonce ever been committed? (Durable replay check.)
    pub fn contains_nonce(&self, nonce: &str) -> bool {
        self.nonces.contains(nonce)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    /// The committed promotions, oldest first.
    pub fn entries(&self) -> &[LedgerEntry] {
        &self.entries
    }

    /// Durably record a committed promotion. Rejects a nonce already present
    /// (durable replay guard). The line is written **and fsync'd before** the
    /// in-memory index advances, so a crash can never leave memory ahead of disk
    /// (it may only leave disk ahead of memory, which the next `open` reconciles).
    /// Returns the new record's hash.
    pub fn record_promotion(
        &mut self,
        authority: &SigningAuthority,
        payload: PromotionRecord,
        timestamp: u64,
    ) -> Result<String, LedgerError> {
        if self.nonces.contains(&payload.nonce) {
            return Err(LedgerError::Replay(payload.nonce));
        }
        let subject = content_hash(&payload);
        let prev = self.entries.last().map(|e| e.record.hash());
        let record =
            WitnessRecord::signed(authority, RecordKind::Promotion, &subject, timestamp, prev);
        let hash = record.hash();
        let entry = LedgerEntry {
            record,
            payload: payload.clone(),
        };
        let line = serde_json::to_string(&entry).expect("entry serializes");

        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?; // durability barrier before we acknowledge the write

        self.nonces.insert(payload.nonce);
        self.entries.push(entry);
        Ok(hash)
    }

    /// Re-verify the in-memory view (chain + payload binding). `open` already does
    /// this; exposed so a long-lived holder can re-check on demand.
    pub fn verify(&self) -> Result<(), LedgerError> {
        let records: Vec<WitnessRecord> = self.entries.iter().map(|e| e.record.clone()).collect();
        verify_chain(&records).map_err(LedgerError::CorruptChain)?;
        for (i, e) in self.entries.iter().enumerate() {
            if e.record.subject_hash != content_hash(&e.payload) {
                return Err(LedgerError::PayloadMismatch(i));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static CTR: AtomicU64 = AtomicU64::new(0);

    /// A unique temp path per test invocation (no external tempfile dep).
    fn tmp() -> PathBuf {
        let n = CTR.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "autogenous-ledger-{}-{n}.jsonl",
            std::process::id()
        ))
    }

    fn auth() -> SigningAuthority {
        SigningAuthority::from_seed("controller-a", [11u8; 32])
    }

    fn rec(nonce: &str) -> PromotionRecord {
        PromotionRecord {
            candidate_hash: format!("cand-{nonce}"),
            parent_hash: "parent-0".into(),
            corpus_id: "corpus-v1".into(),
            nonce: nonce.into(),
            controller_pubkey: auth().public_hex(),
        }
    }

    #[test]
    fn records_and_reconstructs_state_across_restart() {
        let path = tmp();
        let a = auth();
        {
            let mut led = PromotionLedger::open(&path).unwrap();
            assert!(led.is_empty());
            led.record_promotion(&a, rec("n1"), 100).unwrap();
            led.record_promotion(&a, rec("n2"), 200).unwrap();
            led.record_promotion(&a, rec("n3"), 300).unwrap();
            assert_eq!(led.len(), 3);
            assert!(led.contains_nonce("n2"));
        } // dropped — simulate process exit

        // Restart: a fresh open reconstructs the authorized state, no manual edits.
        let led = PromotionLedger::open(&path).unwrap();
        assert_eq!(led.len(), 3);
        assert!(led.contains_nonce("n1") && led.contains_nonce("n2") && led.contains_nonce("n3"));
        assert!(!led.contains_nonce("n4"));
        led.verify().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn durable_replay_is_rejected_within_and_across_restart() {
        let path = tmp();
        let a = auth();
        let mut led = PromotionLedger::open(&path).unwrap();
        led.record_promotion(&a, rec("dup"), 100).unwrap();
        // same-process replay
        let err = led.record_promotion(&a, rec("dup"), 101).unwrap_err();
        assert!(matches!(err, LedgerError::Replay(n) if n == "dup"));
        drop(led);
        // cross-restart replay: the reopened ledger still knows the nonce.
        let mut led2 = PromotionLedger::open(&path).unwrap();
        assert!(led2.contains_nonce("dup"));
        let err2 = led2.record_promotion(&a, rec("dup"), 999).unwrap_err();
        assert!(matches!(err2, LedgerError::Replay(_)));
        assert_eq!(led2.len(), 1, "no duplicate line was appended");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tampering_a_persisted_payload_is_detected() {
        let path = tmp();
        let a = auth();
        {
            let mut led = PromotionLedger::open(&path).unwrap();
            led.record_promotion(&a, rec("n1"), 100).unwrap();
            led.record_promotion(&a, rec("n2"), 200).unwrap();
        }
        // Rewrite line 1's payload nonce WITHOUT re-signing the record.
        let contents = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
        let mut e0: LedgerEntry = serde_json::from_str(&lines[0]).unwrap();
        e0.payload.nonce = "forged".into();
        lines[0] = serde_json::to_string(&e0).unwrap();
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        // The commitment (record.subject_hash) no longer matches the payload.
        let err = PromotionLedger::open(&path).unwrap_err();
        assert!(matches!(err, LedgerError::PayloadMismatch(0)), "got {err}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reordering_persisted_lines_breaks_the_chain() {
        let path = tmp();
        let a = auth();
        {
            let mut led = PromotionLedger::open(&path).unwrap();
            led.record_promotion(&a, rec("n1"), 100).unwrap();
            led.record_promotion(&a, rec("n2"), 200).unwrap();
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
        lines.swap(0, 1); // break the prev-hash links
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let err = PromotionLedger::open(&path).unwrap_err();
        assert!(matches!(err, LedgerError::CorruptChain(_)), "got {err}");
        let _ = std::fs::remove_file(&path);
    }
}
