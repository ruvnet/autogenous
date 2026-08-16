# ADR-401 — The Perpetual Intelligence Machine (capability synthesis + acceptance test)

- Status: Accepted (framing + capability map) · Partial (implementation)
- Date: 2026-08-16 · Updated: 2026-08-16 (Update 1 — new-angles research landed, two overclaims corrected; V1 milestone #2 built & passing — fusion beats best-single, lineage-weighted fusion defeats correlated false consensus)
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
2. **Better decisions than the strongest individual agent** — **BUILT & PASSING**
   (`examples/bench-fusion.ts` + `test/fusion-bench.test.ts`, deterministic
   corpus `examples/fusion-corpus.ts`). On independent-error tasks the fused
   mixture scores **100% vs 66.7% best-single (+33.3%)**. The bench also
   established a sharper, honest result on *correlated*-error tasks: naive-vote
   AND the mixture's `selectIndependent` source-dedup are both dragged *below*
   best-single (66.7% < 75%) by a confidently-wrong same-lineage cluster —
   source-dedup is necessary but **not sufficient** — while **lineage-weighted
   fusion (`effectiveSupport`) recovers to 100%** (+25% vs best, +33.3% vs
   naive). Empirical proof of Decision 2 / capability 3: *independence must be
   measured by lineage, not just shared sourceIds.* Produced by the mesh itself
   (codex implementer expert wrote the corpus; the mixer wrote the fusion
   harness).
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

## Update 1 (2026-08-16) — new-angles research addendum (LANDED)

Scoped deep-research (16 agents, ~2.3M tokens, adversarial refutation per
high-impact claim; the *expertise-markets* search agent died on a session
limit — that angle is under-covered, flagged below). It **validated the
posture but corrected two overclaims.** Only claims that survived refutation
are cited.

### Angle 1 — persistent false consensus: direction confirmed, one invariant demoted

The framing is right and the risk is real, with published effect sizes:

- **Capable models' errors are converging** as capability rises — agreement
  among similar models is *weakening* evidence of correctness (CAPA metric,
  *Great Models Think Alike*, arXiv:2502.04313, ICML 2025). This directly
  backs the `accuracyBand` penalty in `lineage-independence.ts`: two
  frontier-band models are partially correlated regardless of provider/arch.
- **More agents agreeing is not safety.** Unguided homogeneous debate can score
  *worse than isolated self-correction* (20.7% vs 48.3% on GSM-Hard, 10 identical
  agents; *The Cost of Consensus*, arXiv:2605.00914). Independence, not headcount,
  is the safety variable.
- **Conformity is structural**, not incidental: agents publicly conform to norms
  they privately reject at 64–94% (*Everyone Conforms, No One Believes*,
  arXiv:2608.02758). → dissent must be *preserved*, not majority-voted away —
  and in ~1 in 4 divergent cases the minority holds the correct answer
  (*Minority Sentinel*, arXiv:2606.29270). `mixture.ts` retaining contradictions
  is the right instinct.
- **The one mitigation with a measured effect size is task-outcome
  verification**: adding a high-level task-objective verification step yielded
  **+15.6% task success** (MAST, arXiv:2503.13657, NeurIPS 2025 D&B). Structured
  adversarial debate also raises non-expert judge accuracy 48%→76% (Khan et al.,
  arXiv:2402.06782). These back the *adversarial-expert* and *external-outcome-
  verification* prongs of Decision 2.
- **CORRECTION to Decision 2:** "external outcome verification *before durable-
  memory write*" specifically has **no published effect size anywhere** as of
  2026 (arXiv:2606.04329). It stays a standing invariant on *design* grounds —
  but it must NOT be presented as an evidence-validated mitigation. The measured
  win is task-outcome verification at the *action* gate (+15.6%), not the
  memory-write gate.
- **Durable memory is an active attack surface**, reinforcing capability 2's
  provenance requirement: with similarity-only retrieval and no provenance, 10
  poisoned entries captured 47.9% of retrievals and auto-load into every future
  agent (MemoryGraft, arXiv:2512.16962; MINJA, arXiv:2601.05504). The signed,
  hash-chained `rvf-trajectory.ts` ledger is the provenance the attack exploits
  its absence of — but note published defenses carry *no* quantified
  effectiveness yet, so this is a guard, not a solved problem.

### Angle 2 — the weight formula has ZERO literature backing (demoted to hypothesis)

No claim about agent expertise markets or the `w=q·t·r/(c·l)` weight form
survived — or was even submitted to — verification (the search agent hit the
session limit). **Capability 3's multiplicative weight form is an internal
design hypothesis requiring in-house empirical validation, not a research-
supported mechanism.** The Partial status already reflected the missing graded
`t`; this Update adds that the *form itself* is unvalidated. (Re-running the
under-covered angle is a loop item.)

### Angle 3 — cross-org: signed-findings sharing is deployed; pooled training is pilot-stage

- **Sharing signed findings is production-real** — the Cyber Threat Alliance
  moves ~10M STIX 2.1 observables/month across 36 member vendors — but on
  **membership/contractual trust, with no cryptographic signing and no numeric
  confidence scores** (cyberthreatalliance.org sharing model). The mesh's
  signed-frame + confidence disclosure is therefore *ahead* of deployed
  practice, not behind it — capability 6's disclosure half is realistic.
- **Federated training across sovereign orgs is pilot-stage**: Swift's 13-bank
  federated fraud model was 2× as effective — but only on 10M *synthetic*
  transactions, real-data trials still ahead (swift.com, 15 Sep 2025). So
  capability 6's "cooperate without pooling data" via *shared model training*
  remains research, while *shared findings* is deployable now.

### Net effect on this ADR

No capability status changes, but three honesty corrections stand: (a) the
memory-write verification invariant is design-motivated, not evidence-validated
— the validated win is at the action gate; (b) the `w=q·t·r/(c·l)` form is an
unvalidated in-house hypothesis; (c) capability 6 splits into a deployable
disclosure half and a research pooled-training half. Full research note archived
at `docs/research/2026-08-16-pim-new-angles.md`.
