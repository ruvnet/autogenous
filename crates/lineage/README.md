# lineage — content-addressed provenance DAG + quality-diversity archive (Rust)

`lineage` is the provenance plane of [Autogenous](../), a self-evolving AI-defense
runtime in Rust. It records the **complete ancestry** of every genome, mutation,
and antibody so you can reconstruct — and cryptographically verify — how any
deployed defense came to exist.

Everything is **content-addressed** (a node's id is the hash of its payload) and
**append-only** (you add and query, never mutate in place), so history stays
reproducible for forensic replay.

> Keywords: provenance graph, content-addressed DAG, append-only ancestry, lineage
> tracking, quality-diversity archive, MAP-Elites, reproducible history, Rust.

## What's inside

- **`LineageGraph`** — a DAG of `Node`s (genome / mutation / antibody / promotion),
  each pointing at its parents by content hash and optionally sealed by a
  [`witness`](../witness) `WitnessSeal`.
  - `append(node)` → the node's content-hash id.
  - `ancestry(id)` → the full path back to roots.
  - `verify()` → checks every edge resolves *and* every seal is valid.
- **`Archive`** — a quality-diversity archive: keeps the best entry per *niche*, so
  the system retains a diverse frontier of defenses rather than collapsing to one.

## Why content addressing

Because a node's identity *is* the hash of its content, two machines that build the
same artifact get the same id — lineage from different deployments reconciles
automatically, and any tampering changes the id and breaks the chain.

## Example

```rust
use lineage::{LineageGraph, Node, NodeKind};

let mut g = LineageGraph::new();
let root = g.append(Node::new(NodeKind::Genome, vec![], &payload, None))?;
let child = g.append(Node::new(NodeKind::Mutation, vec![root], &mut_payload, Some(seal)))?;

assert!(g.verify().is_ok());                    // every edge + seal checks out
let path = g.ancestry(&child).unwrap();          // back to the root genome
```

## Where it fits

Seals its nodes with [`witness`](../witness); populated by [`runtime`](../runtime)
as it drives the [`generator`](../generator) → [`promotion`](../promotion) loop.

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 §5/§10/§14 in [`docs/adr/`](../../docs/adr).
