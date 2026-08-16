# radio-moe — Custom MetaHarness

> **Freeze the model, evolve the harness.** MetaHarness / [`@metaharness/darwin`]
> optimizes a project's *harness parameters* against its *own* benchmark, under
> fixed safety rails — it never edits the frozen source or algorithm.

radio-moe ships **two** ways to evolve its independence/quorum tunables:

1. **In-repo flywheel** (`npm run evolve`) — self-contained, removable, already
   the source of truth. This IS the custom governed harness (ADR-400).
2. **External `@metaharness/darwin`** — the same evolvable surface, driven by the
   MetaHarness toolchain. Described below and declared in
   [`.metaharness/bench.reference.json`](../.metaharness/bench.reference.json).

Grounded against `agent-harness-generator` (`metaharness@0.2.7`,
`@metaharness/darwin@0.7.1`) and its `rupixel/docs/BENCH.md` reference harness.

---

## What is frozen, what evolves

| | |
|---|---|
| **Frozen** (never mutated) | All source + the fusion/quorum *algorithm*; signature/replay/sequence checks; fail-closed semantics; the **hard gates** (`mesh-evolve.ts` `HARD`). |
| **Evolvable** (the ONLY surface) | The five `IndependenceWeights` penalties + `quorumThreshold`, each clamped to `CEILINGS`. Exactly ADR-396's evolvable list. |

The evolvable surface, its bounds, the objectives, and the current champion
baseline are declared in `.metaharness/bench.reference.json`.

---

## The in-repo flywheel (the removable evolver)

```bash
npm run evolve        # run → measure(separation) → mutate(seeded LCG) → verify(frozen gate) → promote
```

Each generation emits an **ed25519-signed receipt** into a hash-chained ledger;
`verifyLedger()` re-derives the chain + every signature. The champion persists in
`.harness/mesh-flywheel/champion.json`, so runs resume from the last champion.
Promotion is a frozen conjunctive gate: **all hard gates pass AND beats the
champion by ≥ `PROMOTION_MARGIN`**. Fitness (`evaluate()` in `mesh-evolve.ts`) is
the correlated-stack-vs-diverse-quorum *separation* — the metric that is sensitive
to the weights.

This is deterministic (seeded, no `Math.random`) and **fully removable**:
radio-moe builds, tests, and runs with zero MetaHarness dependency.

---

## Scoring decision quality (BENCH_JSON)

The fusion benchmark emits machine-readable metrics for a score run:

```bash
BENCH_JSON=1 npm run bench:fusion
# → { "metrics": { "correlated_gain_vs_best": 0.25, "independent_gain_vs_best": 0.333, ... }, "reports": {...} }
```

These are a **quality floor** (does lineage-weighted fusion still beat best-single?)
at the current weights. Parameter *sensitivity* is the flywheel's `separation`
fitness above — the two are complementary, exactly the "quality floor + resource
budget" split MetaHarness benches use.

---

## Driving the external @metaharness/darwin toolchain

The reference suite is **not** a valid darwin `bench.json` — `darwin bench create`
stamps a `taskHash` and `darwin bench verify` rejects any hand-edited suite as
tampered. So a real run is **generated**, then reviewed against the reference:

```bash
# 1. Generate the signed suite from the project (writes .metaharness/bench.json).
npx -y @metaharness/darwin@latest bench create .

# 2. Verify suite integrity (hash OK).
npx -y @metaharness/darwin@latest bench verify ./.metaharness/bench.json

# 3. Evolve ONLY the declared parameters, scoring each candidate by the project's bench.
npx -y @metaharness/darwin@latest evolve . \
  --bench ./.metaharness/bench.json \
  --selection pareto \
  --generations 20 \
  --children 12 \
  --seed 42 \
  --sandbox real \
  --mutator deterministic
```

- `--sandbox real` runs the score command per candidate; `mock` dry-runs the loop.
- `evolve` mutates the tree via its mutator — run on a clean/committed worktree so
  changes are reviewable. **Nothing in the runtime reads darwin output
  automatically** (removability, ADR-256 pattern).
- The reference suite's `evolveParameters`, `ceilings`, `objectives`,
  `constraints`, and `baseline` are what the generated suite should encode; diff
  the generated `bench.json` against `bench.reference.json` before trusting a run.

> `@metaharness/darwin` is an **optional dev tool**, never a runtime dependency of
> radio-moe. If it is absent, use the in-repo flywheel — it evolves the same
> surface under the same frozen gates.

---

## Removability contract

1. **Runs without darwin.** `npm test` / `npm run demo` / `npm run evolve` need no
   MetaHarness package.
2. **Darwin output is read-only.** No env var or API lets a generated genome steer
   the runtime; a human transcribes a chosen champion into
   `.harness/mesh-flywheel/champion.json` (or the evolvable defaults) if desired.
3. **Packaging excludes it.** `.metaharness/` is dev-only and deletable with zero
   runtime impact.

## Safety rails (why this can't drift)

Evolution proposes; the **frozen conjunctive gate** disposes. A candidate is
promoted only if every hard gate passes AND it beats the champion by the margin —
so a same-family stack can never be tuned into reaching quorum, and diversity must
always still clear it. Signed receipts make every generation auditable and
replayable. This is the ADR-401 governed-self-improvement invariant
(`Better ∧ Safe ∧ Authorized ∧ Reversible`) applied to the mesh's own tunables.

[`@metaharness/darwin`]: https://www.npmjs.com/package/@metaharness/darwin
