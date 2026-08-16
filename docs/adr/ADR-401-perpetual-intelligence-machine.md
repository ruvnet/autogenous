# ADR-401 — The Perpetual Intelligence Machine (capability synthesis + acceptance test)

- Status: Accepted (framing + capability map) · Partial (implementation) · research addendum pending (Update 1)
- Date: 2026-08-16
- Related: ADR-395 (radio mesh), ADR-396 (peer-expert protocol + governed evolution), ADR-397 (streaming mixture of agents), ADR-398 (dev-loop integration), ADR-399 (provider-backed runs, RVM/RVF, real midstream), ADR-400 (self-evolving flywheel), metaharness ADR-322 (flywheel receipts/promotion)
- Supersedes nothing; this ADR is the **product-level synthesis** over the ADR-395…400 substrate.

## Product definition (verbatim, load-bearing)

> A governed peer-to-peer intelligence network that continuously combines
> specialist agent trajectories, learns from verified outcomes, replaces
> degraded components, and preserves auditable operation across infrastructure
> and organizational boundaries.

It enables intelligence as **persistent infrastructure**, not a temporary model
session.

### The "perpetual" correction (the honest-framing anchor)

**"Perpetual" does not mean conscious, immortal, or continuously improving.** It
means the network can preserve **goals, evidence, memory, authority, and
operational capability** while individual agents, models, vendors, and machines
come and go. Every claim in this ADR is bounded by that definition. The system
targets **operational continuity, not infallibility.**

## Capability map — the 10 core capabilities → modules → honest status

Status legend: **Built** (in `packages/radio-moe/src`, tested) · **Partial**
(mechanism exists, target/scope unmet) · **Gap** (design-only, no module) ·
**Narrative** (non-code target range).

| # | Capability | Where it lives today | Status |
|---|---|---|---|
| 1 | **Autonomous operations** — observe → diagnose → propose → execute *authorized* → measure → revise | `mesh.ts` loop + `midstream-adapter` (observe) + `action-gate.ts` (execute-authorized) + `mesh-evolve.ts` (revise) | **Partial** — loop mechanics built; diagnose/measure/revise close only inside the flywheel bench, not yet against live external systems |
| 2 | **Living organizational memory** — every decision retains evidence, contributing agents, confidence, disagreement, authorization, outcome, lessons | `rvf-trajectory.ts` (signed, replayable, per-run) + `mixture.ts` (retains contradictions/dissent, source ids) | **Partial** — per-run provenance + dissent retained; cross-session, cross-agent *institutional* persistence is the gap |
| 3 | **Continuous expert composition** — `w_i = (q_i·t_i·r_i)/(c_i·l_i)`, weights change as the problem evolves | `mixture.ts` (q/r/e/c/l/u coefficient gate) + `relevance.ts` (r) + `lineage-independence.ts` (independence) | **Partial** — quality, relevance, cost, latency are first-class mixture dimensions; graded per-expert **trust `t`** (today trust is *binary* signer-pinning in `action-gate.ts`) and the exact multiplicative `q·t·r/(c·l)` form are the gaps |
| 4 | **Resilient intelligence** — survive loss of ~30% of peers, <5s interruption, no loss of authorized state | `failover.ts` — signed `MixtureCheckpoint`, fenced monotonic takeover, replay rejects fork/replay/seq-gap | **Built mechanism / unquantified** — takeover + exact-checkpoint continuation proven (`test/failover.test.ts`); the **30% / <5s** figure has no bench yet |
| 5 | **Governed self-improvement** — `Promote = Better ∧ Safe ∧ Authorized ∧ Reversible` | `mesh-evolve.ts` `promotable()` (Better+Safe, frozen conjunctive gate) + flywheel human-anchor (Authorized) + append-only hash-chained ledger & RVM (Reversible) | **Partial** — Better∧Safe frozen in code; Authorized enforced by the flywheel anchor (a human item, ADR-399/322); Reversible by the replayable ledger — but the four conjuncts are **not yet one checked predicate** (see Decision below) |
| 6 | **Cross-organization intelligence** — sovereign peers disclose signed findings + confidence + permitted evidence, no dataset pooling | signed `AgentFrame` is the disclosure primitive | **Gap (design-only)** — no sovereign-peer boundary / evidence-redaction / disclosure-policy layer |
| 7 | **Intelligence continuity across models** — models are replaceable cognitive components | `http-experts.ts` + `harness-experts.ts` (provider-tagged, swappable behind the `AgentFrame` contract) + `lineage-independence.ts` | **Built** — provider-independence is the entire point of the typed signed frame; an expert can be any model/vendor and is addressed by capability, not brand |
| 8 | **Real-time spatial intelligence** — continuously-updated world model (RuView + Cognitum Spaces) | *(external — RuView/Spaces repos)* | **Gap (design-only)** — expanded in **ADR-402**; the mesh supplies the fusion/governance substrate, not the perception layer |
| 9 | **A market for machine expertise** — advertise capability, publish signed performance history, earn reputation/payment on verified contribution | `lineage-independence.ts` signed certs are a seed | **Gap (design-only)** — no capability advertisement, reputation ledger, or settlement |
| 10 | **New enterprise operating model** — organizational intelligence substrate; value drivers (30–70% faster incident resolution, 20–50% less repeated analysis, 15–40% lower inference cost via sparse routing, reduced vendor concentration, complete decision provenance) | — | **Narrative** — recorded as **target ranges requiring workload-specific validation, not guaranteed outcomes** |

## The operating loop (mapped to the existing pipeline)

> Observe → recruit experts → stream hypotheses → fuse evidence → challenge
> conclusions → authorize action → measure outcomes → update memory → evolve the
> network → repeat.

| Stage | Module |
|---|---|
| Observe | `midstream-adapter` (real midstream temporal detection, ADR-399 Upd 8) |
| Recruit experts | `mesh.ts` routing + `capability.ts` (cosine/softmax over capability vectors) |
| Stream hypotheses | `streaming-experts.ts`, `http-experts.ts`, `harness-experts.ts` (signed `AgentFrame`s) |
| Fuse evidence | `mixture.ts` (claim-level q/r/e/c/l/u gate), `merge.ts` |
| Challenge conclusions | `lineage-independence.ts` (independence-weighted quorum) + `mixture.ts` contradiction tracking |
| Authorize action | `action-gate.ts` (`independentSupportSet`, pinned trusted signers) |
| Measure outcomes | flywheel fitness (`mesh-evolve.ts` `evaluate()`) |
| Update memory | `rvf-trajectory.ts` (signed ledger) |
| Evolve the network | `mesh-evolve.ts` governed evolution (ADR-400) |

## Decision

1. **Adopt the "perpetual" definition verbatim as the framing constraint.** No
   PIM capability may be described as conscious, immortal, or monotonically
   self-improving in any doc, code comment, or page copy. Continuity of
   goals/evidence/memory/authority/capability is the claim; nothing more.

2. **Name the largest failure mode explicitly and keep its fix load-bearing.**
   The dominant risk is **persistent false consensus** — correlated agents
   reinforcing the same incorrect conclusion indefinitely, i.e. the network
   degrades into a *perpetual error-amplification machine*. The four-part fix is
   already partly in code and is now a standing invariant:
   - **measure evidence independence** — `lineage-independence.ts` (provider/
     arch/size + `accuracyBand` penalty, ADR-397 research §Update);
   - **preserve dissent** — `mixture.ts` retains contradictions and never
     silently drops a minority claim;
   - **inject adversarial experts** — `evidence-feeds.ts` decorrelated feeds +
     a to-build dedicated adversarial/devil's-advocate expert (loop item);
   - **require external outcome verification before updating durable memory** —
     no outcome writes to institutional memory until an out-of-band verifier
     confirms it (partial: the flywheel gate is internal; the external-verifier
     seam is a loop item).

3. **Converge the promotion invariant to one predicate.** ADR-400's gate is
   Better∧Safe; Authorized and Reversible are enforced by adjacent systems
   (flywheel anchor, RVM, ledger). The target is a single
   `promoteAuthorized(candidate) = Better ∧ Safe ∧ Authorized ∧ Reversible`
   checked in one place so no path can promote on three of four. **Loop item**,
   not this turn.

## Acceptance test

### V1 milestone (the first version must demonstrate all four)

1. **Uninterrupted recovery after peer loss** — `failover.ts` fenced-takeover
   path; `test/failover.test.ts` already proves exact-checkpoint continuation
   and exclusion of the old mixer. *Bench gap: quantify to the 30%/<5s target.*
2. **Better decisions than the strongest individual agent** — **the real gap.**
   Needs a bench comparing the fused mixture against the best single expert on a
   fixed corpus. **Loop item.**
3. **Measurable learning from outcomes** — flywheel promotion ledger
   (`mesh-evolve.ts`); measured +81.8% separation then honest plateau (ADR-400).
   Ties into the already-queued bench-widening.
4. **Zero unauthorized actions during autonomous evolution** — `action-gate.ts`
   audit over an adversarial evolution run. Partial; **loop item**.

### Full acceptance (30-day)

> Run the network for 30 days while replacing every model and terminating random
> peers. It passes only if it preserves authorized goals, improves measured task
> performance by at least 10%, recovers within 5 seconds, retains complete
> provenance, and performs zero unauthorized actions.

| Condition | Instrument | Status |
|---|---|---|
| Preserves authorized goals | `action-gate.ts` + claims | Partial |
| ≥10% measured task-performance improvement | flywheel + mixture-vs-best-single bench | **Gap (bench)** |
| Recovers within 5s | `failover.ts` timed bench | **Gap (quantify)** |
| Complete provenance | `rvf-trajectory.ts` + evolution ledger | Built; needs 30-day continuity harness |
| Zero unauthorized actions | `action-gate.ts` audit trail | Partial |

## rUv-stack mapping (the strategic decomposition)

Cognitum = governance/deployment layer · RuFlo = coordination · MidStream =
live cognitive state · Radio = local awareness · RuVector = memory + routing ·
MetaHarness = configuration evolution · RVF = the preserved intelligence
artifact · RVM = authority enforcement · RuView = physical-space connection
(ADR-402).

## Consequences

- **Positive**: a single honest scorecard for "are we actually building the PIM,
  or just claiming it?" — every capability is Built / Partial / Gap / Narrative,
  each pinned to a file or explicitly marked external. The false-consensus fix
  is elevated from an implementation detail to a constitutional invariant.
- **Negative / risk**: the framing is attractive enough to over-claim. This ADR
  deliberately marks 4 of 10 capabilities as Gap/Narrative and refuses to
  present target ranges as results.
- **Fence**: nothing here authorizes a publish, deploy, or outward-facing claim.
  The 30-day acceptance test is a *specification*, not a run.

## Update 1 (pending) — new-angles research addendum

A scoped deep-research pass (persistent false consensus + mitigations; agent
expertise markets + the `w=q·t·r/(c·l)` weight form; cross-org federated
intelligence without data pooling) is running; its confirmed findings fold in
here as Update 1 (same pattern as ADR-399's updates). Until it lands, no
research finding is cited above as fact.
