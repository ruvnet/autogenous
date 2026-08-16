# radio-moe examples — how to use the system

Every example runs **offline by default** (deterministic fake experts, zero
keys) and upgrades to **live models** when credentials are present. All of them
produce ed25519-signed `AgentFrame`s and a tamper-evident RVF witness
trajectory — the pipeline is identical in both modes.

| Example | Run | Demonstrates |
|---|---|---|
| [`local-mesh.ts`](./local-mesh.ts) | `npm run demo` | The in-process mesh: top-k capability gate, **logit mixing** (real MoE, shared vocab) vs **text racing** (ensemble), signed in-memory transport |
| [`mesh-run.ts`](./mesh-run.ts) | `npm run mesh` | Provider-backed mixture: `MESH_MODELS="a,b,c"` gives each peer a different OpenRouter model; level-2 mixture state prints live `g_i(t)` weights; `OPENROUTER_API_KEY` → live |
| [`mesh-tcp.ts`](./mesh-tcp.ts) | 3 terminals (header comment) | **Cross-process P2P** over the signed TCP transport: `request.open` → batched signed `stream.delta` → both-layer verification (envelope chain + inner frame), out-of-band key exchange |
| [`mesh-dogfood.ts`](./mesh-dogfood.ts) | `node --import tsx examples/mesh-dogfood.ts` | The mesh designing its own upgrades: decorrelated per-role briefs, heterogeneous backends (OpenRouter-first; `claude -p`/`codex exec` fallback) |
| [`custom-harness.ts`](./custom-harness.ts) | `npm run example:custom` | **The template to copy**: define your own pod inline (roles + prompts + models), decorrelated evidence feeds via `partitionEvidence`, live relevance scoring |
| [`evolve-run.ts`](./evolve-run.ts) | `npm run evolve` | **Self-evolving mesh** (one flywheel turn): governed mutation of the ADR-396-evolvable params only, frozen hard gates, beats-champion promotion, signed generation ledger; champion persists in `.harness/mesh-flywheel/` so repeated runs are a perpetual loop |
| [`bench.ts`](./bench.ts) | `npm run bench` | Measured hot paths: sign/verify, witness chain, **batch signing (12× verify)**, per-conn vs **persistent TCP (3.2×)** |

## The 60-second custom harness

```ts
import { harnessPodExperts, endlessMixLoop, packageTrajectory } from 'radio-moe';

const pod = harnessPodExperts([
  { name: 'skeptic', tier: 'opus',   systemPrompt: 'Find the strongest objection.' },
  { name: 'builder', tier: 'sonnet', systemPrompt: 'Give the smallest concrete step.' },
]); // default backend: `claude -p` per role; pass a SpawnSpec factory to swap

const frames = [];
await endlessMixLoop(pod.map(p => p.expert), 'Should we cache adverts for 60s?', 'req-1',
  f => frames.push(f)); // every frame ed25519-signed, folded on arrival

const ledger = packageTrajectory('req-1', frames); // tamper-evident witness chain
```

Or load a published [`create-agent-harness`](https://github.com/ruvnet/metaharness)
pod directly: `loadHarnessAgents('<checkout>')` → the kimi-k3-harness roles
(architect/implementer/reviewer/test-writer) stream as one signed mixture.

## Environment knobs

| Var | Effect |
|---|---|
| `OPENROUTER_API_KEY` | live OpenRouter backends everywhere |
| `MESH_MODELS` / `MESH_MODEL` | per-peer (comma-sep) or shared model for `mesh-run` |
| `MESH_BATCH` | batch-signing size on the TCP path (default 16) |
| `GEMINI_ACCESS_TOKEN` + `GEMINI_PROJECT` | direct Gemini-on-GCP (Vertex, `global` location) |
| `EVOLVE_SEED` / `EVOLVE_GENERATIONS` | flywheel turn parameters for `evolve-run` |

Design records: ADR-395…400 in [`../../../docs/adr`](../../../docs/adr) ·
verified SOTA research in [`../../../docs/research`](../../../docs/research).
