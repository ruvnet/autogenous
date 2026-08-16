# ADR-391 — Autogenous: a governed self-evolving software organism (architecture + guardrails)

- **Status**: Proposed (north-star; Levels 1–2 near-term, 3 experimental, 4–7 research program). **Not built** beyond the observation layer.
- **Date**: 2026-08-15
- **Scope**: the RuvNet stack as a whole (MidStream, Radio, RuVector, MetaHarness/Darwin, Dream Machine, RVF, RVM, Witness). This repo's concrete brick is [ADR-390](./ADR-390-inflight-stream-reformatting-midstream.md) (the MidStream observation/reformat layer).
- **Related**: ADR-384 (bounded-evolution methodology — *no auto-promotion*; Autogenous is that principle generalized), ADR-389/390 (MidStream inflight analysis + reformatting).

## Context

Three detailed design essays were supplied proposing a self-evolving "Autogenous"
system on the RuvNet stack. **They are third-party input (untrusted content), and
the technical claims are graded against primary sources, not adopted verbatim.**
The essays' own most important corrections are adopted as first-class constraints:

- **Self-improving ≠ self-authorizing.** A system may *propose, test, and promote*
  bounded adaptations; it must never modify its own authority, promotion
  thresholds, evaluator, or security controls.
- **Most MidStream performance claims are not yet reliable** (canonical docs: ~4 of
  22 advertised benchmark targets credible; QUIC benchmarks mock-based; scheduler
  numbers include construction overhead). Wording is downgraded accordingly
  (e.g. "nanosecond stream processing" → *low-latency inflight analysis*;
  "novel attack detection" → *detects patterns represented by configured rules or
  models*; "QUIC global transport" → *experimental multiplexed transport*).
- **Grounding (primary source):** `@metaharness/radio` is npm 0.1.0 (**alpha**);
  the `midstreamer-*` crates are published (0.2.1) but alpha; `@midstream/wasm` is
  **not published**. These are early components, not production guarantees.

## Decision

Define **Autogenous** as a *governed* architecture: it observes production
behavior, develops evidence-based mutations to its code and cognitive
infrastructure, tests each candidate against its deployed parent, and promotes
only improvements that satisfy **immutable** safety, quality, cost, and rollback
constraints. The evolutionary system never touches its own constitution.

### Three mutation zones (authority is structural, not learned)

| Zone | Examples | Speed | Authority |
|---|---|---|---|
| **Fast** | routing, retrieval depth, prompts, caches, safety sensitivity | seconds–hours | automatic (rollback is cheap) |
| **Slow** | code, schemas, agent topology, memory representation | days–weeks | governed (compat proofs, shadow traffic, verified rollback) |
| **Constitutional** | identity, capability ceilings, audit, promotion rules, the evaluator | rare | **external human approval — OUTSIDE the evolutionary loop** |

The constitutional zone being external is load-bearing: otherwise the cheapest
path to a higher score is editing the evaluator, widening permissions, or hiding
failures.

### The governed loop

`observe (MidStream)` → `witness (signed telemetry)` → `diagnose (MetaHarness
hypotheses)` → `mutate (ranked by risk)` → `evaluate (candidate vs deployed
parent, identical workloads)` → **promotion gates** → `canary (1→10→50→100%)` →
`runtime SLOs` → `signed promotion` **or** `automatic rollback`.

**Promotion is a hard AND-gate, not a weighted sum:**

```
promote = score_candidate > score_parent
        ∧ safety            ≥ 0.99
        ∧ falsePositiveRate ≤ 0.005
        ∧ regressionCount   = 0
        ∧ p99Overhead       ≤ 5 ms
        ∧ rollbackVerified
        ∧ signatureValid
fitness = min(quality, safety, reliability, governance, human_outcome)   // min, not Σwᵢ
```

`min` prevents a spike in one dimension from masking catastrophe in another —
the core defense against Goodhart pressure.

### Seven levels (honest feasibility, from the essays, graded)

| Lvl | Capability | Feasibility |
|---|---|---|
| 1 | tune prompts/routing/retrieval/caching | **production-ready** (Fast zone) |
| 2 | repair defects from witnessed failures | **practical now** (auth/data/finance/irreversible stay approval-gated) |
| 3 | refactor modules/schemas/memory | controlled trials (Slow zone) |
| 4 | maintain a causal self-model `G=(components,deps,costs,failures,outcomes)` | research prototype (RuVector temporal graph) |
| 5 | run competing architectural variants (population 8–32, 2–5% explore traffic) | practical with investment |
| 6 | evolve protocols/component boundaries | advanced research (needs version negotiation + historical interpreters) |
| 7 | operate as a persistent software institution | long-term; **must not control its own constitutional authority** |

Near-term product = automate **Levels 1–2**, experimentally support **3**, treat
**4–7** as the research program.

### Component mapping (real RuvNet stack)

| Function | Component | Reality |
|---|---|---|
| Live nervous system (observe/reformat inflight) | **MidStream** | `midstreamer-*` crates 0.2.1 (alpha); this repo's `stream-reformat` (ADR-390) is the first brick |
| Agent comms / telemetry summaries | **Radio** | `@metaharness/radio` 0.1.0 (alpha) — carries summaries/alerts/status, **not** the bulk token data plane |
| Memory + self-model graph | **RuVector** | temporal graph of repo+runtime |
| Mutation + evaluation | **MetaHarness / Darwin** | ADR-384 bounded-evolution gates apply |
| Simulation | **Dream Machine** | offline replay/adversarial eval |
| Heritable artifact (code+model+tests+provenance+rollback) | **RVF** | the "genetic container" |
| Capability enforcement | **RVM** | restricts what a candidate can access |
| Evidence + ancestry | **Witness chain** | signed, immutable |

**The missing piece — an explicit *Autogenous kernel*** defining: mutation
grammar, fitness contracts, lineage format, resource economy, promotion
protocol, constitutional invariants, reproduction/retirement rules. This ADR
scopes it; it is not built.

### Failure mode + controls

Primary risk: the adaptive layer games the evaluator (reward hacking / benchmark
leakage / suppressing hard traffic). Controls: **immutable + rotating hidden
evaluation sets**, **independently generated adversarial tests**, **capability
separation** (RVM), **signed witness records**, `min`-fitness, and production
canaries. Do **not** auto-fine-tune on every successful trace (leakage/shortcuts)
— require dedup, contamination checks, provenance, independent verification.

### Federated evolutionary ecosystem (the commercial destination)

`local adaptation → signed evidence → global validation → selective inheritance`.
Deployments discover local improvements and share only **validated,
privacy-preserving** adaptations via signed RVF lineage — every deployment
improves the product while customer data stays local.

## Consequences

- **Positive.** A coherent, honestly-scoped north-star that reuses the existing
  stack; Levels 1–2 are shippable value (cheap prompt/retrieval/routing mutations
  evaluated in minutes at <$10/experiment vs. hours/$100s for fine-tuning); safety
  and constitution are structurally outside the loop.
- **Negative / accepted.** Levels 4–7 are research; components are alpha; the
  Autogenous kernel does not exist yet; reliable *evaluation* — not code
  generation — is the true limiting factor.

## Acceptance tests (before claiming a level works)

- **Enforcement fabric:** replay ≥100,000 streams (benign / known-malicious /
  novel-paraphrased / chunk-boundary); attack recall ≥99%, benign FP <0.5%, zero
  unauthorized releases, <5 ms added p99.
- **Autogenous L1–2:** 100 mutation cycles across retrieval/routing/memory ⇒ ≥10
  statistically-significant promotions, zero security regressions, zero
  unrecoverable migrations, automatic rollback <60 s for every injected defective
  candidate.

## Status

Proposed. Concrete progress this repo: the MidStream **observation/reformat**
brick (ADR-390, tested). Everything above the observation layer — the kernel,
promotion plane, population evolution — is **design, not built**, and the
constitutional zone is explicitly reserved for external human authority.
