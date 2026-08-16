# ADR-393 — Autogenous product thesis: the evolutionary control plane + adaptive agent firewall

- **Status**: Proposed (product definition; supersedes nothing — narrows ADR-391/392 to a shippable wedge)
- **Date**: 2026-08-15
- **Related**: [ADR-392](./ADR-392-autogenous-genome-language-antibody-protocol.md) (the AGL/AAP contract this productizes), [ADR-391](./ADR-391-autogenous-governed-self-evolving-architecture.md) (north-star), [ADR-390](./ADR-390-inflight-stream-reformatting-midstream.md) (shipped observation brick).
- **Provenance note**: adopted from external product-design input as *Proposed*; components referenced are alpha; the economics below are hypotheses until benchmarked.

## One sentence

**We are turning runtime failures into verified, portable, reversible software adaptations.**

## What this is (and is not)

A **governed operating system for software** that can learn from production, redesign parts of itself, *prove* the redesign is better, deploy it safely, and reverse it when wrong. **Not** artificial life, **not** a magical self-rewriting repository, **not** another agent framework. The core product is an **evolutionary control plane**:

`observe production → explain failures → generate adaptations → test against parent → proof gates → canary → promote-or-rollback → observe`

## First use case — the adaptive agent firewall

1. **MidStream** observes token/agent traffic.
2. A novel attack or failure becomes **signed evidence**.
3. **MetaHarness** generates candidate defenses.
4. **Darwin** tests competing candidates against malicious *and* benign traffic.
5. The **verifier** rejects capability expansion and regressions.
6. **RVF** packages the winning defense with tests, provenance, expiration, rollback.
7. **RVM** runs it with constrained authority.
8. Successful defenses **transfer across deployments without transferring private traffic**.

## Why a typed mutation language (not source patches)

Every change must declare: what it changes · why it should work · where it is valid · what authority it requires · which invariants it preserves · how it was tested · when it expires · how to reverse it. (The AGL/AAP contract, ADR-392.)

## Scope discipline — the 8–12 week credible first product is ONLY four things

1. A **typed mutation specification**
2. A **MidStream incident adapter**
3. A **MetaHarness candidate generator + evaluator**
4. A **canary controller** with signed promotion and automatic rollback

**Explicitly deferred as research** (do not build first): invented instruction sets, latent protocols, custom algebras, autonomous constitutional evolution. They distract from proving the economic loop.

## Business test

`Value = incidents_prevented + engineering_hours_saved + inference_cost_reduced − evolution_operating_cost`

Hypothesis (unbenchmarked): a deployment at 10M agent interactions/month that cuts guardrail+inference cost 15%, prevents one material incident, and saves 100 engineering hours plausibly generates **$50k–$250k/month** of value, supporting **$10k–$50k/month** enterprise pricing. Initial buyer: enterprises running high-volume agents where attacks, model changes, cost drift, retrieval failures, and tool regressions evolve faster than conventional release cycles.

## Biggest uncertainty + mitigation

Whether generated adaptations **generalize beyond replay datasets**. Mitigation: shadow traffic, hidden evaluations, gradual canaries, short expiration periods.

## Acceptance test

Demonstrate **one previously-unseen attack becoming a deployed defense within 30 minutes**, with ≥99% attack recall, <0.5% benign blocking, <5 ms p99 overhead, and automatic rollback after an injected regression.

## Status

Proposed. The shipped observation-layer brick is ADR-390 (`stream-reformat` / `llm-stream-reformat@0.1.0`). The four-component MVP is the next build; nothing else in the Autogenous program precedes it.
