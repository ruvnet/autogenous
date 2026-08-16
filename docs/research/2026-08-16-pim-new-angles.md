# Deep research: PIM new angles (beyond ADR-397's streaming-mixture corpus)

- Date: 2026-08-16 · Method: 3-angle web fan-out → falsifiable-claim extraction →
  adversarial refutation (default-refuted, primary-source required) → synthesis.
  16 agents, ~2.3M tokens, 113 tool calls. **The `expertise-markets` search
  agent died on a session limit** — angle 2 is under-covered (re-run queued).
- Feeds: ADR-401 Update 1. Three angles ADR-397's research did not cover:
  (1) persistent false consensus + mitigations, (2) agent expertise markets +
  the `w=q·t·r/(c·l)` weight form, (3) cross-org federated intelligence without
  data pooling.
- Verification protocol: nothing here was *outright refuted*, but several
  collected claims were never verified — those are listed separately and must
  not be cited as established.

## Headline verdicts

- **Angle 1 (false consensus)** — a *correlated-error* problem, not a
  deliberation problem. Capable models increasingly make the same mistakes, so
  agreement among similar agents is weakening evidence; social dynamics
  (sycophancy, conformity, pluralistic ignorance) amplify shared error.
  Mitigations that work restore independence. **Gap: verify-before-write for
  durable memory is repeatedly proposed but has no published effect size.**
- **Angle 2 (expertise markets / weight formula)** — **no claim survived or was
  even submitted to verification.** The `w=q·t·r/(c·l)` form has zero literature
  backing here; it is an internal hypothesis requiring in-house validation.
- **Angle 3 (cross-org)** — production cross-org intelligence sharing runs on
  membership/contractual trust, not cryptography; cross-org federated *training*
  without pooling raw data is pilot-stage. Sharing findings = deployed;
  federated model training = research.

## Confirmed findings (survived adversarial refutation)

### Angle 1 — false consensus and mitigations
- Model mistakes converge as capability rises (CAPA chance-adjusted error-overlap);
  LLM-judge scores favor judge-similar models. — *Great Models Think Alike and
  this Undermines AI Oversight*, arXiv:2502.04313 (ICML 2025)
- Unguided homogeneous debate inverts the benefit: 10 identical Ministral-3-8B on
  GSM-Hard scored 20.7% (debate) vs 48.3% (isolated self-correction), at 2.1–3.4×
  token cost. — *The Cost of Consensus*, arXiv:2605.00914
- Pluralistic ignorance in agent populations: across 8 frontier models, agents
  publicly conform to a privately-opposed norm at 64–94%; a lone dissenter
  triggers a corrective cascade <26% of the time for 7 of 8; conformity persists
  52–92% with conformity-inducing instructions removed. — *Everyone Conforms, No
  One Believes*, arXiv:2608.02758
- Dissent preservation pays: in ~1 in 4 divergent debate cases the minority holds
  the correct answer; a meta-classifier over debate-log fingerprints overturns the
  majority at 81.2% flip precision, positive net gain across 6 datasets/20 seeds.
  — *Minority Sentinel*, arXiv:2606.29270
- Structured adversarial roles: two expert debaters on opposing answers raise
  non-expert judge accuracy to 76% (LLM) / 88% (human) vs 48%/60% naive. — Khan
  et al., arXiv:2402.06782 (ICML 2024)
- Verification failures ≈ 24% of 1,642 annotated multi-agent failure traces;
  adding a high-level task-objective verification step to ChatDev gave **+15.6%
  task success** — the one mitigation with a published intervention effect size.
  — MAST, arXiv:2503.13657 (NeurIPS 2025 D&B)
- Verify-before-write for durable memory remains proposed but unmeasured; best
  off-the-shelf poisoning detector (PromptArmor) reaches 67.67% TPR, 42.5% on
  weak-signal attacks. — arXiv:2606.04329
- Query-only memory injection (MINJA) hit >95% injection / ~70% attack success
  under idealized empty-memory conditions; pre-existing legitimate memories
  reduce effectiveness — headline rates are best-case-for-attacker. —
  arXiv:2601.05504
- With similarity-only retrieval (BM25 ∪ FAISS) and no provenance, 10 poisoned
  entries among 110 captured 47.9% of retrievals and auto-load into every future
  agent instantiation; proposed provenance/reranking defenses carry no quantified
  effectiveness. — MemoryGraft, arXiv:2512.16962

### Angle 3 — cross-org intelligence
- Cyber Threat Alliance: production since Feb 2017, ~10M observables/month as
  STIX 2.1 across 36 member vendors, value-scoring algorithm rewarding
  timeliness/context, submissions attributed to the member — **no cryptographic
  signing, no numeric confidence-score** in the published model. —
  cyberthreatalliance.org/about/our-sharing-model/
- Swift 2025 federated-learning fraud experiments (13 institutions incl. ANZ,
  BNY, Intesa Sanpaolo; Google Cloud): collaborative model **2× as effective** as
  single-institution — but only on 10M *synthetic* transactions; real-data phase
  ahead. — swift.com press release, 15 Sep 2025

## Refuted / do not claim

Nothing outright refuted, but do NOT present as established fact:
- Do not attach the 85.5% sycophancy / 90.1% false-consensus figures to the
  Ministral/GSM-Hard condition — they are paper-wide maxima (Qwen2.5-7B on
  MMLU-Hard), arXiv:2605.00914.
- MemoryGraft retrieval is BM25 ∪ FAISS (similarity-only, no provenance), *not*
  "embedding-only."
- CTA membership: page says 36; hedge the count.
- **Never cite verify-before-write as a validated mitigation** — no measured
  effect size (arXiv:2606.04329).

**Collected but never verified (label "unverified" or omit):** sycophancy-score
exposure +10.5pp (arXiv:2604.02668); architectural heterogeneity preserving
disagreement (arXiv:2604.26561); CISA AIS decline 304→135; Meta FIRE ~20k scam
removals; MELLODDY 10-pharma consortium; BIS Project Aurora; npm/Sigstore
provenance scale; SCITT draft status; Apple Private Cloud Compute; MISP trust
model; Swift Payment Controls.

**Absent entirely:** any evidence for agent expertise markets or the
`w=q·t·r/(c·l)` weight form — angle 2's search agent died on the session limit;
this angle needs a re-run before capability 3's formula is treated as anything
but an internal hypothesis.
