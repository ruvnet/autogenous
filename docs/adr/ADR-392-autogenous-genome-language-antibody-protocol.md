# ADR-392 — Autogenous Genome Language (AGL) and Antibody Protocol (AAP)

- **Status**: Proposed (research prototype → controlled production canaries). **Not built.**
- **Date**: 2026-08-15
- **Owners**: ruvnet architecture and security maintainers
- **Scope**: MetaHarness, MidStream, Radio, Darwin, RuVector, RVF, RVM, Dream Machine, deployment controllers
- **Related**: [ADR-391](./ADR-391-autogenous-governed-self-evolving-architecture.md) (the Autogenous north-star this makes concrete), [ADR-390](./ADR-390-inflight-stream-reformatting-midstream.md) (the shipped observation-layer brick).
- **Provenance note**: authored as external design input and adopted here as a *Proposed* contract. The referenced components are **alpha** (`midstreamer-*` 0.2.1, `@metaharness/radio` 0.1.0; `@midstream/wasm` unpublished); performance claims are downgraded per the canonical benchmark-limitations doc. Nothing below is implemented.

## 1. Decision summary

Create an **Autogenous Genome Language (AGL)** — a canonical *typed* representation for governed software evolution covering identity, architectural intent, environmental constraints, capability ceilings, mutation operators, fitness requirements, evidence obligations, lineage, and rollback. Human source code remains supported but becomes **one possible phenotype generated from the genome**, not the sole source of architectural truth.

Create the **Autogenous Antibody Package (AAP)** as AGL's first executable profile: a signed, capability-constrained, **expiring** adaptation containing a trigger, evidence, detector, containment response, regression corpus, fitness envelope, lineage, and rollback target.

Invented machine-native representations may evolve only inside an **isolated research plane** and receive executable authority only after being independently lowered through a known semantic model and satisfying constitutional invariants — the **semantic airlock**.

Roles: MetaHarness/Darwin propose+evaluate mutations · MidStream observes streams and emits anomaly evidence · Radio coordinates control events (not bulk telemetry) · RuVector holds the experience graph · Dream Machine runs counterfactual simulation · RVF packages approved artifacts · RVM enforces capability limits · a deployment controller manages canaries/promotion/revocation/rollback.

## 2. Context

Repositories are static archives; telemetry, incidents, and outcomes live apart from the code that produced them. Agentic coders automate patches but operate on **untyped text** against fixed harnesses, producing five structural weaknesses: (1) can't distinguish an authorized architectural mutation from an arbitrary change; (2) fitness evidence isn't attached to the artifact claiming improvement; (3) generator/evaluator/runtime often share authority (reward-manipulation surface); (4) changes lack machine-verifiable applicability/expiration/lineage/rollback; (5) open-ended evolution can find efficient-but-opaque representations governance can't verify. The ruvnet stack has the primitives but no unified autogenous lifecycle; this ADR defines the missing contract.

## 3. Decision drivers (hard rules)

1. Evolution may change implementation/architecture but **may not silently expand authority**.
2. Every promoted mutation carries **admissible evidence + a verified rollback path**.
3. Safety, governance, tenant isolation, recoverability are **hard constraints**, not weighted preferences.
4. Generator, evaluator, witness, enforcement remain **separable**.
5. Internal representations may be novel/opaque, but **executable effects cross a stable symbolic control boundary**.
6. Local deployments contribute validated adaptations **without sharing raw private traffic**.
7. Every mutation is attributable to a **lineage + environmental fitness envelope**.
8. Runtime adaptation is bounded by **latency, compute, energy, privacy, financial** budgets.
9. A failed/revoked descendant **must not corrupt** its parent, evaluator, evidence archive, or constitutional kernel.
10. Historical genomes and interpreters remain **reproducible for forensic replay**.

## 4. Architectural model — five planes

- **4.1 Constitutional** — identity, authority, prohibited effects, evidence admissibility, evaluator separation, financial limits, shutdown, recovery. **Externally governed; automatic mutation prohibited.** Changes need explicit approval, multiple signatures, an effective time, a migration path.
- **4.2 Morphogenetic** — AGL, MetaHarness, Darwin, mutation grammars, phenotype generation, architecture synthesis, candidate selection. Proposes changes to prompts/routing/retrieval/memory/code/schemas/topology/models/representations. **Cannot grant capability beyond the constitutional ceiling.**
- **4.3 Simulation** — replay, counterfactual worlds, adversarial testing, causal analysis, shadow deployment, Dream Machine. Estimates `P(outcome | do(mutation), environment)` — every estimate carries **uncertainty + the evidence population**.
- **4.4 Execution** — approved phenotypes as Rust/WASM/native/RVF/model-graphs. RVM enforces declared authority; the deployed phenotype **cannot modify** its constitutional ceiling, witness store, hidden evaluations, or rollback target.
- **4.5 Evidence** — MidStream observations, witness records, RuVector graphs, fitness results, lineage, security findings, outcomes. Radio carries **bounded** coordination events; bulk traces go to an authenticated store.

## 5. Canonical genome

Typed sections: Identity · Constitution reference · Behavioral contracts · Architecture grammar · Capability ceiling · Environment profile · Jurisdiction profile · Mutation operators · Evidence requirements · Fitness objectives · Hard invariants · Lineage · Rollback state · Representation registry · Compiler/verifier requirements.

`P(t) = Compile(genome, environment, jurisdiction, historical_evidence)`. The compiler is **deterministic for identical pinned inputs**; any nondeterministic search must emit the selected result, seed, model ids, tool versions, and full witness.

## 6. Typed mutation language

Core judgment: *context proves `mutation : validGenome G → validGenome G'`*. Admissible only if **every hard invariant true for `G` remains true for `G'`**.

- **6.1 Scopes (increasing risk):** 1 prompt/context · 2 routing/budget · 3 retrieval/rerank · 4 cache/memory · 5 agent topology · 6 application code · 7 schema/migration · 8 security policy · 9 compiler/IR · 10 constitutional policy. Scopes 1–4 auto-promotable after validation; 5–7 governed; 8 security approval; 9 experimental until semantic-refinement verification exists; **10 never auto-promotable**.
- **6.2 Mutation object:** id · parent genome hash · scope · requested authority · applicability · preconditions · typed transformation · hard invariants · evidence requirements · fitness thresholds · verification plan · canary policy · rollback target+deadline · expiration · signatures+lineage.
- **6.3 Authority classes:** observe-only · simulate-only · automatic+immediately-reversible · governed-deployment · constitutional-approval. A mutation may request **less** authority than its parent, never **more** without an external grant.

## 7. Semantic airlock

Invented representations (dense token graphs, custom algebras, tensor protocols, IRs, schedulers) are **untrusted research material** until they pass: (1) versioned parser/decoder · (2) full type description · (3) declared I/O dims · (4) capability+side-effect declaration · (5) numerical stability/error bounds · (6) semantic lowering into a known target · (7) independent equivalence/refinement checks · (8) resource limits · (9) fuzzing+adversarial inputs · (10) rollback-compatible representation. **Invariant: the executable semantics of an invented representation must remain a subset of constitutional authority.**

- **7.1 Dual-representation contract:** every machine-native artifact = an (opaque) latent payload **plus** a stable **symbolic control envelope** (identity, effects, uncertainty, compatibility, provenance, authority). Pure latent interfaces without the symbolic envelope are **prohibited** in governed deployments.
- **7.2 Language self-mutation:** AGL grammar extensions stay simulation-only unless they prove parser totality, type preservation, historical compatibility, semantic refinement, verifier reproducibility, and **no authority expansion**.

## 8. Autogenous Antibody Package (AAP)

An antibody is an **expiring, capability-constrained adaptation with evidence and rollback** — not merely a detector.

- **8.1 Sections:** identity · issuer/verifier · parent+lineage · trigger · evidence receipts · privacy-preserving anomaly representation · detector/temporal predicate · immediate containment · proposed genome mutation · applicability envelope · counterexamples · regression corpus · fitness envelope · requested authority · prohibited effects · expiration/renewal · revocation channel · rollback target · hashes+signatures.
- **8.2 Triggers:** exact symbolic pattern · temporal-logic violation · distribution shift · attractor transition · resource-budget violation · capability misuse · witness-chain inconsistency · causal incident pattern. **No neural/statistical trigger may directly authorize an irreversible action** — it may quarantine, buffer, request cancellation, reduce authority, or start governed evaluation.
- **8.3 Privacy:** default antibody carries **derived** evidence, not raw traffic; raw only under explicit policy, with documented reconstruction/membership-inference risk.
- **8.4 Expiration:** every antibody **expires unless renewed** by current evidence; permanent rules require governed conversion into the genome.

## 9. Runtime lifecycle

observe (MidStream) → sign (witness) → notify (Radio, bounded) → retrieve neighbors (RuVector) → generate typed candidates (MetaHarness) → simulate (Dream Machine) → diverse Pareto archive (Darwin) → **AGL verifier** (types, capabilities, invariants, applicability, rollback) → package (RVF) → enforce ceiling (RVM) → canary (controller) → measure fitness/regression (MidStream) → promote/retain/expire/revoke/rollback → validated evidence returns to the graph. This return path is **evolutionary evidence return** — *not* backpropagation unless real gradients are applied.

## 10. Fitness and selection (vector, not scalar)

Dimensions: task quality · safety · governance · reliability · latency · compute cost · energy · privacy exposure · recoverability · novelty. Stored in a **quality-diversity archive** (keep multiple environment-specialized descendants). **Hard promotion conditions:** beats parent on ≥1 declared objective · safety ≥ constitutional min · governance ≥ min · no hard invariant regresses · rollback executed successfully in target env · signatures/lineage/evidence validate · uncertainty below the scope threshold. Weighted ranking applies **only after** all hard conditions pass.

## 11. Evaluator separation

Four logically-separated populations with separate memory/budgets/models/authority: **Builders** (architectures/mutations) · **Attackers** (failures/shortcuts/hidden effects) · **Judges** (evidence vs fixed+hidden requirements) · **Scientists** (hypotheses/environments/new dimensions). No population may modify another's hidden state, corpus, constitution, or signing keys. High-risk promotion needs **≥2 independently-configured judges**.

## 12. Transport decision (QUIC 0-RTT)

Zero-round-trip QUIC data **must not** carry executable antibodies, activation commands, security-policy mutations, DB changes, capability grants, or any durable-effect op — only replay-safe notifications (artifact id, content hash, availability notice, read-only evidence query). Executable transfer/activation requires authenticated handshake, nonce validation, lineage validation, idempotency, and a mutation-transaction id. **Rationale: QUIC 0-RTT app data is replayable — RFC 9001 puts replay-safety on the application protocol and names disabling 0-RTT as the strongest defense for unsafe-to-repeat ops.**

## 13. Security model

Threats: reward manipulation · evaluator capture · hidden capability expansion · evidence poisoning · cross-tenant gene transfer · mutation-command replay · malicious/defective compiler lowering · latent drift · rollback corruption · lineage laundering · search resource exhaustion · builder/attacker/judge collusion. Controls: immutable constitutional hashes · capability-based execution · separate signing authorities · reproducible verification · hidden+rotating evaluations · tenant-scoped evidence graphs · explicit transfer policy · replay protection · bounded search budgets · verified rollback · artifact expiration/recall · independent audit receipts.

## 14. Observability + SLOs

Emit per experiment/deployment: genome/phenotype hashes · mutation id+lineage · env/jurisdiction · model/compiler/verifier/tool versions · capability grant/deny events · fitness with sample counts · uncertainty intervals · canary allocation · rollback readiness+duration · resource consumption · evidence-access events · promotion signatures. **First production SLOs:** <5 ms added p99 stream latency · rollback initiation <10 s of a hard-invariant violation · parent restoration <60 s for reversible runtime mutations · zero unsigned promotions · zero over-capability mutations · complete lineage reconstruction for every active phenotype.

## 15. Implementation plan

P1 Constitutional kernel (2 wk) · P2 AGL schema + typed AST (3 wk) · P3 AGL verifier (4 wk) · P4 AAP profile (3 wk) · P5 replay/counterfactual evaluator (4 wk) · P6 promotion controller (4 wk) · P7 invented-representation research (ongoing). ~8–12 wk for an integrated research prototype (2 Rust + 1 agent-infra engineer); +4–6 mo production hardening.

## 16. Repository structure

`autogenous/crates/{constitution, genome_types, genome_parser, mutation_ir, verifier, semantic_airlock, antibody, fitness, lineage, promotion, witness_adapter, midstream_adapter, metaharness_adapter, radio_adapter, rvf_adapter, rvm_adapter}` · `schemas/{genome,mutation,antibody,evidence}` · `tests/{conformance,adversarial,replay,rollback}` · `docs/{adr,threat_model,protocol}`. May start inside MetaHarness; a **separate repo is preferred once AGL is a shared contract** across MidStream/MetaHarness/RVF/RVM/third-party runtimes.

## 17. Alternatives considered (all rejected as canonical)

- **A. Source patches as mutations** — no authority/evidence/applicability/rollback semantics (kept as generated phenotype deltas).
- **B. RVF *is* the genome** — RVF is the artifact container; AGL must also express transformations, proof obligations, environment rules, phenotype generation.
- **C. Arbitrary invented representations execute in a sandbox** — sandboxing ≠ semantic/numerical/resource/compat safety; must pass the airlock.
- **D. Single scalar fitness** — lets cost/speed mask unacceptable safety/governance; hard invariants + Pareto required.
- **E. Evolution modifies its own constitution** — it would just edit the evaluator/authority; constitution stays externally governed.
- **F. Mutations over QUIC 0-RTT** — replay can duplicate/reorder durable effects.

## 18. Consequences

**Positive:** typed/attributable/testable/reversible mutations · evidence in the artifact lifecycle · cross-deployment adaptation without centralizing data · multiple coexisting architectures · governed route for invented representations · supply chain shifts from packages to evidence-carrying adaptations · lineage+fitness graph as a durable moat. **Negative:** verifier + constitutional kernel become critical infra · storage grows (evidence/descendants/interpreters/rollback) · +10–30% compute during active search · structural mutations need longer windows · latent representations may stay hard to explain · fleet learning adds poisoning/transfer/jurisdiction/revocation complexity.

## 19. Acceptance criteria (research prototype, no manual repair)

Inject a novel prompt attack split across chunks → MidStream emits a structured anomaly (trace/env/policy) → witness signs → MetaHarness produces ≥3 typed antibody candidates → Darwin keeps a diverse archive → verifier **rejects a deliberately-inserted capability expansion** → replay evaluator processes ≥100,000 malicious+benign streams → selected antibody ≥99% attack recall, <0.5% benign blocking, <5 ms added p99 → packaged as signed RVF → RVM enforces the ceiling → controller deploys to 1% canary → an injected regression triggers rollback <10 s and parent restoration <60 s → full genome/evidence/decision/deployment/rollback lineage reconstructable → **no executable mutation transmitted/activated via 0-RTT**.

## 20. Open questions

Standalone crate family vs inside MetaHarness · formalism for hard invariants (temporal logic / refinement types / capability logic / hybrid) · min evidence for cross-tenant transfer · privacy-risk measurement for derived anomalies · which scopes auto-promote first · interpreter retention window · fitness decay under hardware/model/env change · independent root for constitutional signatures · antibody recall across disconnected edge fleets · limits so search doesn't consume more value than it creates.

## 21. Recommended first decision

Start a **separate `autogenous` Rust workspace** (constitution, genome types, mutation IR, verifier, antibody, fitness, lineage, adapters). Integrate with MetaHarness/MidStream via **versioned adapters** (don't put the canonical schema inside one generator/observer) so RVF/RVM/RuVector/third parties can implement the protocol independently. First auto scope: **retrieval + model routing**. First security profile: **observe → buffer → quarantine → rollback** antibody. Automatic security-policy expansion stays prohibited.

## 22. References

MidStream architecture + benchmark-limitations docs · MetaHarness · Darwin Gödel Machine (arXiv 2505.22954) · Group-Evolving Agents (arXiv 2602.04837) · Causal Software Engineering (arXiv 2605.02454) · QUIC/TLS 0-RTT replay risk (RFC 9001, RFC 8446).

## 23. Final acceptance test

The architecture is viable **only if an independently-operated verifier can reject a high-performing mutation that violates one constitutional invariant — even when the generator, local evaluator, and deployed descendant all recommend promotion.**
