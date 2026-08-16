//! # lineage — append-only, content-addressed provenance + quality-diversity archive
//!
//! The persistence gap (ADR-392 §5 lineage, §10 quality-diversity archive, §14
//! "complete lineage reconstruction for every active phenotype"). Everything is
//! **content-addressed** (a node's id is the hash of its payload) and
//! **append-only** — you can add and query, never mutate or delete in place, so
//! the history stays reproducible for forensic replay.
//!
//! Two structures:
//! - [`LineageGraph`] — a DAG of [`Node`]s (genomes / mutations / antibodies /
//!   promotions), each pointing at its parents by content hash, each optionally
//!   sealed by a [`witness::WitnessSeal`]. `ancestry` reconstructs the full path
//!   back to roots; `verify` checks that every edge resolves and every seal is
//!   valid.
//! - [`Archive`] — a quality-diversity store keyed by an environment/niche
//!   label: it **retains** competing descendants (poor performers are archived,
//!   not deleted — ADR-392 §10) and returns the current best per niche.
//!
//! The store is in-memory + serializable (serde); a durable backend is an
//! adapter concern, not a contract change.

use serde::{Deserialize, Serialize};
use witness::{content_hash, verify_seal, WitnessSeal};

/// What a lineage node records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Genome,
    Mutation,
    Antibody,
    Promotion,
    Rollback,
}

/// One content-addressed node in the provenance DAG. `id` is derived from the
/// payload+kind+parents (via [`Node::compute_id`]); it is never set by hand.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    /// Content hash(es) of the parent node(s), oldest first.
    pub parents: Vec<String>,
    /// The content hash of the artifact this node represents (genome/mutation…).
    pub payload_hash: String,
    /// Optional witness seal over `payload_hash`.
    pub seal: Option<WitnessSeal>,
}

impl Node {
    /// Build a node and compute its content-addressed id.
    pub fn new(kind: NodeKind, parents: Vec<String>, payload_hash: &str, seal: Option<WitnessSeal>) -> Self {
        let mut n = Node { id: String::new(), kind, parents, payload_hash: payload_hash.into(), seal };
        n.id = n.compute_id();
        n
    }

    /// Deterministic id = hash of (kind, parents, payload_hash). The seal is
    /// excluded so the same artifact+ancestry always addresses to the same id.
    pub fn compute_id(&self) -> String {
        content_hash(&(self.kind, &self.parents, &self.payload_hash))
    }
}

/// Errors from the lineage store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LineageError {
    /// A node's id does not match its recomputed content hash.
    IdMismatch(String),
    /// A parent hash does not resolve to a stored node.
    DanglingParent { node: String, parent: String },
    /// A node's witness seal failed verification.
    BadSeal(String),
    /// A cycle was detected (the DAG invariant is violated).
    Cycle(String),
}

/// Append-only content-addressed provenance DAG.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LineageGraph {
    /// Insertion order preserved; ids are unique (dedup on append).
    nodes: Vec<Node>,
}

impl LineageGraph {
    pub fn new() -> Self {
        LineageGraph::default()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.id == id)
    }

    /// Append a node. Idempotent on the content id (re-appending the same node
    /// is a no-op). Verifies the id, that every parent already exists, and (if
    /// present) the seal — the append is refused, not silently corrupting the
    /// store, on any violation.
    pub fn append(&mut self, node: Node) -> Result<String, LineageError> {
        if node.compute_id() != node.id {
            return Err(LineageError::IdMismatch(node.id));
        }
        for p in &node.parents {
            if self.index_of(p).is_none() {
                return Err(LineageError::DanglingParent { node: node.id.clone(), parent: p.clone() });
            }
        }
        if let Some(seal) = &node.seal {
            if !verify_seal(seal) || seal.subject_hash != node.payload_hash {
                return Err(LineageError::BadSeal(node.id));
            }
        }
        if self.index_of(&node.id).is_none() {
            self.nodes.push(node.clone());
        }
        Ok(node.id)
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.index_of(id).map(|i| &self.nodes[i])
    }

    /// Full ancestry of `id` back to roots (parents-before-children order),
    /// deduplicated. Returns `None` if `id` is unknown.
    pub fn ancestry(&self, id: &str) -> Option<Vec<String>> {
        self.get(id)?;
        let mut order = Vec::new();
        let mut seen = Vec::new();
        self.walk(id, &mut order, &mut seen);
        Some(order)
    }

    fn walk(&self, id: &str, order: &mut Vec<String>, seen: &mut Vec<String>) {
        if seen.iter().any(|s| s == id) {
            return;
        }
        seen.push(id.to_string());
        if let Some(n) = self.get(id) {
            for p in &n.parents {
                self.walk(p, order, seen);
            }
        }
        order.push(id.to_string());
    }

    /// Verify the whole store: every id is content-correct, every parent
    /// resolves, every seal is valid, and there are no cycles.
    pub fn verify(&self) -> Result<(), LineageError> {
        for n in &self.nodes {
            if n.compute_id() != n.id {
                return Err(LineageError::IdMismatch(n.id.clone()));
            }
            for p in &n.parents {
                if self.index_of(p).is_none() {
                    return Err(LineageError::DanglingParent { node: n.id.clone(), parent: p.clone() });
                }
            }
            if let Some(seal) = &n.seal {
                if !verify_seal(seal) || seal.subject_hash != n.payload_hash {
                    return Err(LineageError::BadSeal(n.id.clone()));
                }
            }
        }
        // Acyclicity: since append() requires parents to pre-exist, a content DAG
        // built through `append` is acyclic by construction; verify defensively.
        for n in &self.nodes {
            let mut seen = Vec::new();
            if self.has_cycle(&n.id, &mut seen) {
                return Err(LineageError::Cycle(n.id.clone()));
            }
        }
        Ok(())
    }

    fn has_cycle(&self, id: &str, stack: &mut Vec<String>) -> bool {
        if stack.iter().any(|s| s == id) {
            return true;
        }
        stack.push(id.to_string());
        let cyc = self
            .get(id)
            .map(|n| n.parents.iter().any(|p| self.has_cycle(p, stack)))
            .unwrap_or(false);
        stack.pop();
        cyc
    }
}

/// A scored candidate kept in the quality-diversity archive.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub node_id: String,
    /// The niche/environment label this candidate is specialized for.
    pub niche: String,
    /// Scalar fitness *within its niche* (ranking only applies after the hard
    /// gates pass elsewhere — this store doesn't re-judge admissibility).
    pub score: f64,
}

/// Quality-diversity archive: retains competing descendants per niche (poor
/// performers archived, not deleted — ADR-392 §10), returns the best per niche.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Archive {
    entries: Vec<Entry>,
}

impl Archive {
    pub fn new() -> Self {
        Archive::default()
    }

    /// Insert a candidate. Never evicts — the archive is append-only so a
    /// currently-poor descendant remains available if its niche shifts.
    pub fn insert(&mut self, node_id: &str, niche: &str, score: f64) {
        self.entries.push(Entry { node_id: node_id.into(), niche: niche.into(), score });
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The highest-scoring entry in a niche (ties → first inserted).
    pub fn best(&self, niche: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .filter(|e| e.niche == niche)
            .fold(None, |acc: Option<&Entry>, e| match acc {
                Some(b) if b.score >= e.score => Some(b),
                _ => Some(e),
            })
    }

    /// All distinct niches present, sorted.
    pub fn niches(&self) -> Vec<String> {
        let mut ns: Vec<String> = self.entries.iter().map(|e| e.niche.clone()).collect();
        ns.sort();
        ns.dedup();
        ns
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use witness::SigningAuthority;

    fn seal_for(a: &SigningAuthority, payload_hash: &str) -> WitnessSeal {
        // WitnessSeal comes from witness::SigningAuthority; build via its API.
        a.seal(payload_hash)
    }

    #[test]
    fn append_dedups_and_reconstructs_ancestry() {
        let mut g = LineageGraph::new();
        let g0 = Node::new(NodeKind::Genome, vec![], &content_hash(&"genome-0"), None);
        let g0id = g.append(g0.clone()).unwrap();
        // idempotent re-append
        assert_eq!(g.append(g0).unwrap(), g0id);
        assert_eq!(g.len(), 1);

        let m1 = Node::new(NodeKind::Mutation, vec![g0id.clone()], &content_hash(&"mutation-1"), None);
        let m1id = g.append(m1).unwrap();
        let p2 = Node::new(NodeKind::Promotion, vec![m1id.clone()], &content_hash(&"promotion"), None);
        let p2id = g.append(p2).unwrap();

        let anc = g.ancestry(&p2id).unwrap();
        assert_eq!(anc, vec![g0id, m1id, p2id]); // roots first
        assert!(g.verify().is_ok());
    }

    #[test]
    fn dangling_parents_and_bad_ids_are_refused() {
        let mut g = LineageGraph::new();
        let orphan = Node::new(NodeKind::Mutation, vec!["nonexistent".into()], &content_hash(&"x"), None);
        assert!(matches!(g.append(orphan), Err(LineageError::DanglingParent { .. })));

        let mut tampered = Node::new(NodeKind::Genome, vec![], &content_hash(&"g"), None);
        tampered.payload_hash = "swapped-after-id".into(); // id no longer matches
        assert!(matches!(g.append(tampered), Err(LineageError::IdMismatch(_))));
    }

    #[test]
    fn seals_are_verified_on_append() {
        let a = SigningAuthority::from_seed("controller", [5u8; 32]);
        let mut g = LineageGraph::new();
        let ph = content_hash(&"sealed-genome");
        let good = Node::new(NodeKind::Genome, vec![], &ph, Some(seal_for(&a, &ph)));
        assert!(g.append(good).is_ok());

        // a seal over the wrong payload is refused
        let ph2 = content_hash(&"other-genome");
        let bad = Node::new(NodeKind::Genome, vec![], &ph2, Some(seal_for(&a, &content_hash(&"mismatch"))));
        assert!(matches!(g.append(bad), Err(LineageError::BadSeal(_))));
    }

    #[test]
    fn archive_retains_losers_and_returns_per_niche_best() {
        let mut ar = Archive::new();
        ar.insert("cand-a", "low-latency", 0.7);
        ar.insert("cand-b", "low-latency", 0.9);
        ar.insert("cand-c", "low-latency", 0.5); // poor performer — retained, not deleted
        ar.insert("cand-d", "high-security", 0.8);
        assert_eq!(ar.len(), 4, "no evictions");
        assert_eq!(ar.best("low-latency").unwrap().node_id, "cand-b");
        assert_eq!(ar.best("high-security").unwrap().node_id, "cand-d");
        assert_eq!(ar.niches(), vec!["high-security", "low-latency"]);
        assert!(ar.best("unknown-niche").is_none());
    }

    #[test]
    fn serde_round_trip_preserves_verification() {
        let mut g = LineageGraph::new();
        let g0 = Node::new(NodeKind::Genome, vec![], &content_hash(&"g"), None);
        let g0id = g.append(g0).unwrap();
        g.append(Node::new(NodeKind::Mutation, vec![g0id], &content_hash(&"m"), None)).unwrap();
        let json = serde_json::to_string(&g).unwrap();
        let back: LineageGraph = serde_json::from_str(&json).unwrap();
        assert!(back.verify().is_ok());
        assert_eq!(back.len(), 2);
    }
}
