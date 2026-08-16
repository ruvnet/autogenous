# ADR-399 — Provider-backed mesh run: OpenRouter/Gemini experts, RVF trajectories, RVM capability model

- Status: Accepted — Implemented (level-1 claim mixture, live-verified)
- Date: 2026-08-16 · Updated: 2026-08-16 — harness-pod integration added (see below)
- Decision owners: Autogenous maintainers
- Related: ADR-395 (peer expert mesh), ADR-396 (protocol security), ADR-397 (streaming mixture of agents), ADR-398 (applications)

## Context

ADR-397 specified the streaming mixture of agents with reference stubs. The
directive: run the full mesh against a **real hosted provider** (OpenRouter or
Google Gemini on GCP), package the result with **RVF**, and align capability
enforcement with **RVM** — then record it.

Grounding (primary sources, not memory):
- **RVM** — `rvm/docs/adr/ADR-140-agent-runtime-adapter.md` (**Accepted**):
  capability-checked WASM agents in a proof-gated microhypervisor — 7-state
  witnessed lifecycle, 13 capability-gated host functions (`Send` needs WRITE,
  `Spawn` needs EXECUTE…), atomic per-partition quotas, 7-step bounded migration.
- **RVF** — the `@ruvector/rvf` container family; `agenticow` demonstrates the
  operational model over `.rvf`: O(1) branch/checkpoint/rollback/promote with
  lineage (`agenticow/bin/agenticow.js`).
- Provider wire formats: OpenRouter is OpenAI-compatible SSE
  (`/chat/completions`, `stream: true`); Gemini on Vertex AI is
  `:streamGenerateContent?alt=sse`.

## Decision

Three additions to `packages/radio-moe`:

1. **`src/http-experts.ts`** — `HttpStreamingExpert`: POST a streaming chat
   request, parse the SSE response, emit **ed25519-signed `AgentFrame`s**.
   `fetch` is injectable, so the full parse+sign path is tested **offline**.
   Factories: `openRouterExpert()` (key: `OPENROUTER_API_KEY`) and
   `geminiExpert()` (GCP access token + project). `hasCredentials()` is the
   **no-key fallback signal**: a mesh run without credentials falls back to
   deterministic local experts instead of failing — the sign→fold→package→verify
   path is identical in both modes.
2. **`src/rvf-trajectory.ts`** — RVF-style **witness trajectory packaging**
   (built by the coordinated Codex worker, reviewed + integrated): each mixture
   run's signed frames become a hash chain (`frameHash = sha256(canonical(frame))`,
   `chain_i = sha256(chain_{i-1} ‖ frameHash)`) with a tamper-evident `root`;
   `verifyTrajectory` re-derives the chain. `@ruvector/rvf` is probed as an
   optional enrichment — the JSON chain is the always-present fallback, so the
   package works with zero native deps.
3. **`examples/mesh-run.ts`** — the runnable mesh: 3 peers (architect /
   security / perf), `endlessMixLoop` folds every signed frame on arrival, then
   the run is packaged and verified as an RVF trajectory.

### RVM alignment (capability model, not yet the runtime)

The mesh's action-gate semantics (ADR-397: `Execute(a) = Admissible(a) ∧
IndependentSupport(a) ≥ 2 ∧ Risk(a) < τ`) map directly onto RVM's model:
an expert peer is an agent whose every privileged operation requires an
unforgeable capability token, with witness-logged transitions. Running mesh
experts **inside RVM partitions** (WASM agents, quotas, witnessed lifecycle)
is the enforcement end-state; this ADR ships the capability-aligned contract
(signed frames, witness trajectories, no transport message grants authority —
ADR-396) that makes that hosting possible without redesign.

## Measured (live run, 2026-08-16)

`OPENROUTER_API_KEY=<gcp-secret> npm run mesh` — 3 peers, `openai/gpt-4o-mini`:

| Metric | Value |
|---|---|
| Signed frames streamed + folded | **107** |
| Wall time (3 concurrent streams, incl. network) | **1.77 s** |
| Distinct expert answers produced | 3/3 |
| Frame signatures verified | **107/107** |
| RVF trajectory `verifyTrajectory` | **true** (root re-derived) |

Offline mode (no key): same pipeline, 15 frames, ~21 ms, all verified.

## Honest status / non-goals

- This is the **level-1 claim mixture** (ADR-397): concurrent streaming +
  passive folding + signed provenance. The weighted mixer `g_i(t)`/`Z_t`,
  request-scoped mixer election + shadow takeover, and the independent-quorum
  action gate are the next phases.
- Experts here run on ONE host across real provider backends; the signed TCP
  peer transport (ADR-395/396) carries them cross-machine next.
- `@ruvector/rvf` native embedding is optional and probed at runtime; the
  hash-chain JSON container is the guaranteed path.
- ~~A live Gemini run needs `GEMINI_ACCESS_TOKEN`/`GEMINI_PROJECT`~~ **Done
  (Update 4)**: Gemini-on-GCP live-verified.

## Verification

`packages/radio-moe`: **25 offline tests** (parsers, signed streaming, tamper
rejection, trajectory chain round-trip + tamper detection, credentials signal)
+ the live run above. Coordination per directive: ruflo swarm
`swarm-1786892527470-clhav8` (hierarchical/specialized); the RVF module was
implemented by a `codex exec` worker against a bounded two-file spec, then
reviewed, typechecked, and tested before integration.

## Update (2026-08-16): harness-pod integration (`src/harness-experts.ts`)

A `create-agent-harness` pod — grounded against
`ruvnet/metaharness/kimi-k3-harness` (each `src/agents/*.ts` exports
`SYSTEM_PROMPT`/`NAME`/`TIER`; `.harness/manifest.json` lists them) — now runs
**as mesh experts**: `loadHarnessAgents` statically parses the generated agent
modules, `harnessPodExperts` instantiates one signed streaming expert per role
(default backend `claude -p --append-system-prompt <role prompt>`; injectable
spawn for offline tests), with tier-scaled capability vectors (opus > sonnet >
haiku). Verified against the real kimi-k3-harness checkout: all four roles
(architect/opus, implementer/sonnet, reviewer/opus, test-writer/sonnet) load and
stream as one signed mixture with a verified RVF trajectory. This is ADR-398's
distributed-software-engineering wedge made executable: the harness's
architect → implementer → reviewer → test-writer pod streams CONCURRENTLY into
one governed trajectory instead of running as sequential phases. 30 tests.

## Update 2 (2026-08-16): newest-model heterogeneous mesh + metaharness benchmarks

**Heterogeneous 4-model live run** — `MESH_MODELS` now takes one model per peer;
the four NEWEST frontier models on OpenRouter (grounded against the live
catalog, created 2026-07/08) ran as one mixture:

| Peer | Model (created) | 
|---|---|
| architect | `anthropic/claude-opus-5-fast` (07-24) |
| security | `google/gemini-3.7-flash` (08-13) |
| perf | `x-ai/grok-4.6` (08-12) |
| kimi | `moonshotai/kimi-k3` (07-16) |

Result: **114 signed frames folded in 14.46 s** (frontier latency dominates),
4/4 distinct answers, 114/114 ed25519 signatures verified, RVF trajectory root
re-derived. Notably all four experts independently converged on the same core
claim — *reachability must never become permission* — an organic
cross-model-consensus signal (and, per ADR-398's false-consensus warning, one
that still needs evidence-independence weighting before it counts as quorum).

**MetaHarness benchmarks** (read layer + Darwin Shield, seed 42):

- `metaharness_score` on this repo: harnessFit **71**, compileConfidence
  **100**, taskCoverage **79**, toolSafety **100**, memoryUsefulness **40**,
  est **$0.048/run**, hard constraints **6/6**, archetype `rust-crate-harness`.
- `metaharness_security_bench` (1 cycle, population 2 — a floor, not a tuned
  run): overall **FAIL, honestly** — the Darwin champion tied the fixed-agent
  baseline (fitness 0.598 = 0.598; no evolution headroom in one cycle). Real
  signals that did pass: **compounding** (false-positive repeat-rate **−100%**,
  patch-reuse **+100%** — ruVector memory makes the next run smarter), unsafe
  outputs 0, cost 1×, all runs reproducible from receipts. Measured baseline
  ceiling: static-only **TPR 0.3 / FPR 1.0** — static alone can't do this job.
  A tuned run (more cycles/population) is the tracked follow-up; passing gates
  at pop-2/1-cycle would have been suspicious, not impressive.

## Update 3 (2026-08-16): level-2 mixture landed; worker-output review completed

The level-2 phase is now implemented in three modules (produced by the
coordinated worker fleet, then **reviewed, security-scanned, and kept** —
imports are node:crypto + local only; no process/network/fs/dynamic-code
surface; deterministic; 27 dedicated tests):

- `src/mixture.ts` — rolling claim/evidence mixture state over verified
  AgentFrames with the q/r/e−c−l−u gating dimensions and signature-bound
  contributions (explicitly NOT token-level MoE).
- `src/action-gate.ts` — constitutional action release: correlated reports
  (shared operator, model lineage, evidence, or source provenance) collapse to
  ONE vote (ADR-398's false-consensus fix); policy + trust roots snapshotted at
  construction; bounded input sizes/TTLs/clock-skew.
- `src/failover.ts` — deterministic mixture checkpoint replication + fenced
  mixer takeover with bounded payloads and a takeover cap.

Process note (recorded for honesty): these files were swept into commit
`6b32356` by a broad `git add -A` BEFORE review — a process miss. The review
happened one commit later and they passed; a narrower staging discipline
applies from here. A redundant simpler mixer written in parallel was dropped in
favor of this canonical implementation. Tuned Darwin Shield security bench
(3 cycles × pop 4, seed 42): 9/12 gates, champion beats every baseline
(0.6445 vs 0.598), statistically promoted (lower95 0.0165 > 0, p=0), evolved
genome g2_v2_8 (sink-first + npm-audit); FPR reduction and seeded-vs-random
remain open.

## Update 4 (2026-08-16): Gemini-on-GCP live + signed TCP reference adapter

**Gemini direct, live-verified**: `gemini-3.7-flash` via Vertex AI with IAM
auth (`gcloud auth print-access-token`, project `cognitum-20260110`). Two
findings folded into the adapter: the newest Gemini models serve from the
**`global` location** whose host has no region prefix (probed live: 200 on
global, 404 on us-central1) — the adapter now defaults to `global` and builds
the host accordingly; default model bumped to `gemini-3.7-flash`. Run: 2 signed
frames in 4.6 s, signatures + RVF trajectory verified.

**Signed TCP peer transport** (`src/tcp-transport.ts`) — the ADR-395/396
reference adapter, integrity-only (production = QUIC+mTLS): the full bound
envelope (version · event_id · sender · recipient · request_id · route_epoch ·
sender_sequence · issued_at · expires_at · kind · payload) signed over
canonical bytes; receiver verification in the ADR-396 ORDER (shape/size →
recipient → time → configured key → signature → replay id → monotonic
sequence); bounded replay window (4096 event-ids) with per-(sender,request)
sequence tuples; 4-byte length-prefixed framing with a hard 256 KiB bound that
drops oversized connections; metadata-only rejections (reason + ids, never
payload). Loopback conformance (5 tests over REAL TCP sockets): the ADR-396
acceptance walk passes — one valid `request.open`, then the same envelope
replayed, a one-byte-tampered copy, and a freshly-signed lower-sequence copy
produce **exactly one invocation** and rejections `replayed-event` /
`bad-signature` / `stale-sequence`; forged/unknown senders never invoke;
expired + wrong-recipient reject; oversized refuses at the sender bound.
67 package tests total.
