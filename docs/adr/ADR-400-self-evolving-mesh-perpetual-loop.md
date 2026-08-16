# ADR-400 — Self-evolving mesh: the perpetual flywheel loop

- Status: Accepted — Implemented (first flywheel turn measured)
- Date: 2026-08-16
- Related: ADR-392 (AGL evolvable/frozen boundary), ADR-396 (evolvable parameters), ADR-397 (mixture), ADR-399 (mesh runs), metaharness ADR-322 (flywheel receipts/promotion)

## Decision

Apply the autogenous governed-evolution loop to the mesh's OWN tunables —
`packages/radio-moe/src/mesh-evolve.ts`:

- **Evolvable surface = exactly ADR-396's list**: independence weights and the
  quorum threshold, clamped to constitutional ceilings on every mutation.
  Signature/replay/sequence checks, fail-closed semantics, and the hard gates
  are FROZEN constants — evolution cannot touch them by construction.
- **Flywheel pattern** (metaharness ADR-322): run → measure (deterministic
  fitness on a fixed bench: correlated-stack vs diverse-quorum separation +
  relevance topic separation) → mutate (seeded LCG — fully replayable, no
  Math.random) → verify (frozen conjunctive gate: ALL hard gates AND
  beats-champion by ≥0.02) → promote. Every generation emits an
  **ed25519-signed receipt** into a hash-chained ledger (`verifyLedger`
  re-derives chain + signatures).
- **Perpetual**: `npm run evolve` is one flywheel turn; the champion persists
  in `.harness/mesh-flywheel/champion.json` (kimi-k3-harness layout), so each
  /loop tick resumes evolution from the previous champion.

## Measured (first turn, seed 42, 30 generations × pop 4)

separation **0.6875 → 1.2500 (+81.8%)**, 4 promotions; hard gates ALL PASS at
every recorded generation (family 3-stack held at 1.0 — never reaches quorum —
while the diverse pair holds 2.0); the evolved champion raised same-provider
(0.4→0.625) and same-arch (0.35→0.439) penalties and tuned quorum to 1.868;
ledger root verified. Tests prove: determinism (same seed → same champion),
ceiling clamping over 500 mutations, gate-breaking candidates never promote,
sub-margin lifts never promote, tampered ledgers fail. 81 package tests.

## External benchmark (honest)

`metaharness_flywheel run` **fails closed** without a project-local
human-labelled anchor manifest (`.claude/eval/flywheel-anchor.manifest.json`) —
correct behavior; fabricating "human-labelled" anchors would defeat its
governance. **Named human item**: curate the anchor tasks, then the external
flywheel can evaluate/promote over the same ledger. `metaharness_score` remains
71/100/79/100/40, 6/6 hard constraints (keyed to the Rust archetype; the TS
mesh does not move it).

## Usage

`packages/radio-moe/examples/README.md` documents every runnable example;
`examples/custom-harness.ts` is the copy-me template (inline pod + decorrelated
feeds + signed trajectory); `examples/evolve-run.ts` is the perpetual turn.
