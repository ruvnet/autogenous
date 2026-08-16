# ADR-399 — Provider-backed mesh run: OpenRouter/Gemini experts, RVF trajectories, RVM capability model

- Status: Accepted — Implemented (level-1 claim mixture, live-verified)
- Date: 2026-08-16
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
- A live Gemini run needs `GEMINI_ACCESS_TOKEN`/`GEMINI_PROJECT`; the adapter
  ships tested offline (wire-format parsers), OpenRouter is live-verified.

## Verification

`packages/radio-moe`: **25 offline tests** (parsers, signed streaming, tamper
rejection, trajectory chain round-trip + tamper detection, credentials signal)
+ the live run above. Coordination per directive: ruflo swarm
`swarm-1786892527470-clhav8` (hierarchical/specialized); the RVF module was
implemented by a `codex exec` worker against a bounded two-file spec, then
reviewed, typechecked, and tested before integration.
