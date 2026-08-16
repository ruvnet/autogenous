# Deep research: streaming multi-agent mixtures — 2025–26 SOTA vs ADR-397

- Date: 2026-08-16 · Method: 5-angle web fan-out → 24 sources fetched → 119
  claims extracted → top 25 adversarially verified (3 independent votes each;
  2/3 refutes kills) → **21 confirmed · 3 refuted · 1 unverified** → 10
  synthesized findings. 106 agents, ~15M tokens. (5 verifier votes were lost to
  a session limit; affected claims are marked.)
- Question: is the Autogenous Streaming Mixture of Agents (ADR-397/399) —
  heterogeneous experts streaming ed25519-signed typed frames, continuously
  fused mid-execution, independence-weighted quorum before action release —
  already done elsewhere, and what should it build next?

## Headline verdict (per pillar)

| Pillar | Verdict | Closest prior art |
|---|---|---|
| Continuous structured **claim-level mid-stream fusion** | **Genuinely novel** in the surveyed corpus | MoA fuses complete outputs layer-synchronously (arXiv:2406.04692); AgentNet routes *tasks*, not claims (arXiv:2504.00587); ReM-MoA fuses between layers via memory (arXiv:2606.24437) |
| **Signed frame provenance** | **Partially done** — the combination isn't | ANP signs per-message (ECDSA-secp256r1, *not* ed25519) with nonce+window replay protection; AIP chains Ed25519 Biscuit capability blocks (0.049 ms verify); SLIM gives MLS group-scoped attribution only members can verify. **No deployed interop protocol mandates per-message signed provenance of agent claims** |
| **Independence-weighted quorum** | **Empirically motivated, unbuilt anywhere** | ICML 2025 (arXiv:2506.07962): LLM pairs agree on the *same wrong answer* ~60% when both err (vs 1/3 baseline); provider/architecture/size predict correlation. No surveyed system converts this into vote weights |
| **Governed action release** | **Closest to done** — two conceded gaps remain | AIP (draft-prakash-aip-00): attenuable capability tokens + Datalog policy. But completions are **self-reported** and **TTL-window replay** is delegated to transport — exactly the gaps our quorum-before-release closes |

**The differentiating position is the combination** — plus closing AIP's two
conceded gaps (independent completion verification via counter-signing quorum;
in-frame replay binding).

## Confirmed findings (all 3-0 unless noted)

1. **Original MoA is coarse and blocking** (high): layered, output-level,
   layer-synchronous; led AlpacaEval 2.0 at publication (65.1% vs GPT-4o 57.5%,
   GPT-4-judged). arXiv:2406.04692.
2. **AgentNet = decentralized P2P routing, not fusion** (high): orchestrator-free,
   dynamic DAG built *during* execution — but task-routing level only; no signed
   frames, no quorum, no action gate. Flat-DAG comms cost prohibitive at scale
   (arXiv:2512.00614). arXiv:2504.00587.
3. **MoA collapses with depth** (medium; 2-1 on the gains claim): standard MoA
   peaks by L=3, −9.1 pts on MMLU-redux by L=9; ReM-MoA sustains scaling via
   ranked reasoning memory + **curated diversified routing** (+0.84→+4.92 over
   strongest baseline, L=1..9). Preprint, self-benchmarked. arXiv:2606.24437.
4. **Shared context ⇒ diversity collapse** (high): identical accumulated
   reasoning accelerates correlated convergence; sustained scaling needs
   **deliberately decorrelated per-agent reference sets** (sharing one set costs
   −2.50 avg at L=9). Direct design mandate for our gating: fuse continuously,
   feed experts decorrelated evidence. arXiv:2606.24437 + 2604.18005 + 2602.03794.
5. **ANP is the closest signed-frame analogue** (medium; 2-1 on the algorithm):
   per-message asymmetric signing (EcdsaSecp256r1Signature2019 + SHA-256, *not*
   ed25519) with 32-byte single-use nonces + ~5-min timestamp window.
   agentnetworkprotocol.com spec.
6. **SLIM (AGNTCY/Cisco, draft-mpsb-agntcy-slim-02) is the strongest streaming
   transport** (high): gRPC over HTTP/2+HTTP/3 (QUIC-capable), MLS group
   encryption, zero-trust intermediaries. Critically: attribution is
   **member-only** — unlike bare ed25519 frames, an external auditor/action-gate
   cannot verify who said what.
7. **No interop protocol mandates claim provenance; MCP misbinding is measured**
   (high): only ANP cryptographically guarantees identity; MCP has no
   tool↔provider binding — wrong-provider execution hits **VR 1.0** under
   first-match/trust-cue injection, 0.52 randomized (MCP v1.25.0, 100
   trials/condition). arXiv:2602.11327.
8. **AIP proves per-message ed25519 is cheap** (high): 0.049 ms verify (Rust),
   340–380 B/delegation block, +2.35 ms (0.086%) end-to-end in a real Gemini
   deployment. Gaps AIP concedes: self-reported completion records; replay
   within TTL. arXiv:2603.24775.
9. **Independent-vote quorum is empirically violated** (high; 2-0, 1 vote lost):
   ~60% same-wrong-answer agreement (HELM, 71 models); replicated 0.423 vs
   0.127 (Open LLM Leaderboard); same-provider/architecture/size significantly
   predict correlation (R² 0.34–0.61); llama-3.2-90b/3.1-70b agree 0.97 when
   both wrong. **Load-bearing caveat**: accuracy dominates — see Unverified.
   arXiv:2506.07962 (ICML 2025, peer-reviewed).
10. **Novelty synthesis** (medium — argument from absence; angle 4 uncovered):
    as per the verdict table above.

## Refuted — do not repeat these claims

- ANP verification happens at the receiving Message Proxy (0-3 — do not assume
  proxy-side verification).
- A2A task claims are wholly unverifiable at protocol level (0-3 — A2A v1.0
  added *optional* JWS card signatures; weaker than mandatory provenance, not zero).
- "~2,000 unauthenticated MCP servers" (Knostic figure) (1-2).

## ~~Unverified~~ → RESOLVED (2026-08-16, primary-source check)

- **CONFIRMED** — arXiv:2506.07962 abstract, verbatim: *"larger and more
  accurate models have highly correlated errors, even with distinct
  architectures and providers."* Naive provider/architecture diversity
  weighting therefore **overestimates independence among frontier models**.
  Folded into code: `ModelLineage.accuracyBand` ('frontier'|'strong'|'baseline')
  with a `sameAccuracyBand` penalty (default 0.2, tunable) in
  `lineage-independence.ts` — two frontier-band models are partially correlated
  regardless of lineage. The band axis is excluded from flywheel mutation until
  it gets its own bench.

## Angle-4 addendum (2026-08-16, targeted check)

- **FusionRoute** (arXiv:2601.05106, primary): token/logit-level fusion — a
  lightweight router selects the expert per decoding step AND contributes a
  complementary logit; beats sequence- and token-level collaboration, merging,
  and fine-tuning across Llama-3/Gemma-2 families. **No shared-tokenizer
  discussion, no signed provenance, no quorum, no governance** — i.e. strong
  intra-family token fusion exists (maps to our ADR-395 `logit_mix` profile,
  which already enforces exact tokenizer match), and the governed/signed/quorum
  combination remains unoccupied. The angle-4 caveat on the novelty verdict is
  hereby narrowed, not removed: cross-family token fusion remains under-surveyed.

## Open questions

1. Does the accuracy-correlation effect hold at frontier scale, and what
   residual independence signal remains once accuracy is conditioned out?
2. Actual SOTA in token/logit-level cross-model fusion + mid-stream steering —
   **angle 4 produced no verified claims** (FusionRoute-style token routers and
   CoS speculative collaboration surfaced in search but didn't survive into the
   verified set); closer prior art to "continuous fusion" may exist there.
   Known signal: naive per-token ensembling *degrades* long-form generation —
   fusion positioning must be selective.
3. Can SLIM-style MLS group encryption compose with externally-verifiable
   per-frame ed25519 signatures without double-signing overhead?
4. Is a **counter-signing quorum** (k-of-n attestation before a completion
   frame counts as evidence) practical at streaming latencies — closing AIP's
   self-reported-completions and replay-within-TTL gaps in one mechanism?

## Derived build items (folded into the loop)

1. **Decorrelated evidence feeds** (finding 4): per-expert curated reference
   sets in the mixture — never identical context to all experts.
2. **Independence features in the quorum** (finding 9): extend the action gate's
   correlated-vote collapse with model provider/architecture/size lineage —
   pending the unverified accuracy-correlation check.
3. **Counter-signing quorum for completions** (finding 8 + OQ4): k-of-n
   attestation frames before a completion counts as evidence.
4. **In-frame replay binding**: bind AgentFrames to the envelope
   nonce/sequence so replay-within-TTL cannot detach frames from their stream.
5. **External-auditor attribution beside MLS** (OQ3): keep bare ed25519 frame
   signatures as the auditor-verifiable layer if SLIM/MLS is ever adopted as
   transport.

## Sources (24 fetched; key primaries)

arXiv:2406.04692 (MoA) · 2504.00587 (AgentNet) · 2606.24437 (ReM-MoA) ·
2602.11327 (protocol threat model, CIC/Mastercard) · 2603.24775 (AIP) ·
2506.07962 (correlated errors, ICML 2025) · draft-mpsb-agntcy-slim (SLIM I-D) ·
ANP DID message spec · 2604.18005, 2602.03794 (diversity collapse) ·
2601.05106 (FusionRoute) · 2510.15346, ACM 3780338.3781021 (CoS) · Microsoft
agent-governance toolkit + runtime-authorization blog · full list in the
workflow journal.

*Time-sensitivity is high: SLIM is an active I-D (expires Jan 2027), A2A/MCP
security surfaces evolve quarterly (draft-sharif-mcps-secure-mcp-00 would add
exactly the signatures MCP lacks).*
