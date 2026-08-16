# radio-moe — User Guide

A task-oriented tour of the governed streaming peer-expert mesh. Every snippet
runs offline and deterministically unless it says otherwise. For the full export
list see the [API / SDK Reference](API.md); for the design rationale see the ADRs
linked from each section.

- [1. Install & verify](#1-install--verify)
- [2. Your first mesh (routing + combine)](#2-your-first-mesh-routing--combine)
- [3. The streaming mixture of agents (signed frames → fused decision)](#3-the-streaming-mixture-of-agents)
- [4. Governed action release (independence-weighted quorum)](#4-governed-action-release)
- [5. Running against real models](#5-running-against-real-models)
- [6. Self-evolving the mesh (the flywheel)](#6-self-evolving-the-mesh)
- [7. Defeating false consensus (lineage-weighted fusion)](#7-defeating-false-consensus)
- [Mental model & glossary](#mental-model--glossary)

---

## 1. Install & verify

```bash
cd packages/radio-moe
npm install
npm test              # 87 offline, deterministic tests
npm run demo          # a 3-peer local mesh — both regimes
```

`radio-moe` is ESM + TypeScript, run via `tsx` (`node --import tsx`). It has no
runtime service, no database, and no network by default — the reference transport
is an in-process signed fabric.

---

## 2. Your first mesh (routing + combine)

A **Peer** hosts **Experts**; a **Gate** routes each input chunk to the top-k
experts by capability; their output is combined in the regime that fits.

```ts
import { Fabric, InMemorySignedTransport, PeerIdentity, Peer, LogitExpert } from 'radio-moe';

const fabric = new Fabric();
const mk = () => { const id = PeerIdentity.generate(); return new Peer(id, new InMemorySignedTransport(id, fabric)); };
const [a, b] = [mk(), mk()];

// LogitExpert(name, capabilityVector, vocabId, vocabSize, logitsFn)
a.host(new LogitExpert('grammar', [1, 0, 0, 0], 'vocab', 4, () => [3, 0, 0, 0]));
b.host(new LogitExpert('facts',   [0, 1, 0, 0], 'vocab', 4, () => [0, 3, 0, 0]));

const res = a.route({ streamId: 's', seq: 0, features: [0.9, 0.6, 0, 0] }, 'logit');
console.log(res.merged);   // { kind: 'logit', ... }  ← Σ wᵢ·logitsᵢ, real MoE
console.log(res.metrics);  // routingMs, timeToFirstFrameMs, dataFrames, rejectedFrames
```

**Logit vs text is a hard fork, not a toggle.** Experts sharing a `vocabId` are
*mixed* (`mixLogits`, real MoE). Heterogeneous text experts are *raced*
(`raceTextExperts`) and typed `regime: 'text-ensemble'` — an ensemble, not a
mixture. `mixLogits` throws `IncompatibleVocabError` across vocabularies by design
(ADR-395/396). Every data frame is ed25519-signed; a tampered/spoofed frame is
dropped and counted in `metrics.rejectedFrames`, never mixed.

---

## 3. The streaming mixture of agents

Above the raw frames sits ADR-397's request-scoped layer: heterogeneous experts
stream typed, signed `AgentFrame`s (`claim`/`evidence`/`plan`/`action`), and a
`MixtureState` folds them continuously with deterministic q/r/e/c/l/u weighting,
provenance, and contradiction tracking.

```ts
import { PeerIdentity, signFrame, MixtureState, signContributionInput } from 'radio-moe';

const expert = PeerIdentity.generate();
const mix = new MixtureState({
  requestId: 'q-42',
  trustedSigners: { 'analyst': expert.publicKeyDer.toString('hex') },
});

const frame = signFrame(expert, {
  requestId: 'q-42', agentId: 'analyst', step: 0, kind: 'claim',
  value: 'opt-c', confidence: 0.8, uncertainty: 0.2,
  dependencies: [], capabilityUsed: 'answer', evidenceHashes: [], cost: 0.1,
});
const input = signContributionInput(expert, frame, {
  claimId: 'opt-c', relation: 'support', sourceIds: ['src-analyst'],
  quality: 0.8, relevance: 0.9, evidence: 0.7, cost: 0.1, latency: 0.2, uncertainty: 0.2,
});

const update = mix.consume(frame, input);        // 'accepted' | 'buffered' | 'duplicate' | 'rejected'
const snap = mix.snapshot();                       // immutable, replica-stable
console.log(snap.claims);                          // [{ claimId, netWeight, confidence, contradictory, ... }]
```

Key guarantees: only frames from `trustedSigners` are admitted; a contribution
carries a **binding signature** over its frame hash + dimensions; per-agent steps
must be contiguous (gaps buffer, conflicts quarantine the signer for
equivocation); and `snapshot().stateHash` is identical on any replica that saw the
same frames — the basis for fenced failover (§ *DeterministicShadow*).

---

## 4. Governed action release

An action executes only from **signed, admitted, independently-sourced** support
that clears a frozen policy. Independence prevents a correlated bloc from
self-authorizing.

```ts
import { ActionGate, signActionSupport, PeerIdentity } from 'radio-moe';

const a = PeerIdentity.generate(), b = PeerIdentity.generate();
const gate = new ActionGate({
  trustedSigners: new Map([
    ['a', a.publicKeyDer.toString('hex')],
    ['b', b.publicKeyDer.toString('hex')],
  ]),
  minimumQuorum: 2,
  riskThreshold: 0.8,
  admissible: async (_action, _independent) => true,   // your policy predicate
});

const action = { kind: 'deploy', payload: { service: 'gateway' } };
const supports = [/* signActionSupport(a, {...}), signActionSupport(b, {...}) */];
const decision = await gate.evaluate(action, supports);
// { execute, independentSupport, risk, rejection?: 'insufficient-independent-quorum' | 'risk-threshold' | ... }
```

Today independence at the gate is **binary** (distinct modelId ∧ disjoint
sourceIds) via `independentSupportSet`. The graded, lineage-aware upgrade
(`effectiveSupport`) is available as a decision helper — see § 7 — and is being
wired into the gate under its own review (it changes *when actions execute*).

---

## 5. Running against real models

Swap the fake experts for real streaming backends — the frame contract is
identical, so everything above still holds.

```ts
import { openRouterExpert, geminiExpert, PeerIdentity } from 'radio-moe';

const id = PeerIdentity.generate();
const analyst = openRouterExpert('analyst', id, [1, 0, 0], { model: 'google/gemini-3.7-flash' });
// needs OPENROUTER_API_KEY;  geminiExpert needs GEMINI_ACCESS_TOKEN + GEMINI_PROJECT

for await (const frame of analyst.run('Summarize the risk.', 'req-1')) {
  // each SSE delta → a signed AgentFrame
}
if (!analyst.hasCredentials()) { /* fall back to a local/mock expert */ }
```

Other backends: `CommandStreamingExpert` drives a local `claude -p` or
`codex exec` (`claudeCodeStreamExpert` / `codexStreamExpert`); `harnessPodExperts`
runs a create-agent-harness pod as mesh experts. `examples/custom-harness.ts` is a
copy-paste template for your own pod (roles, prompts, decorrelated evidence feeds,
signed frames, RVF witness trajectory).

---

## 6. Self-evolving the mesh

The mesh applies its own governed-evolution loop to its **own tunables** — but
only the *evolvable* surface (ADR-396: independence weights + quorum threshold),
clamped to constitutional `CEILINGS`. Signature/replay/sequence checks, fail-closed
semantics, and the hard gates are frozen constants evolution cannot touch.

```bash
npm run evolve        # one flywheel turn: run → measure → mutate → verify → promote
```

```ts
import { evolveMesh, verifyLedger, PeerIdentity } from 'radio-moe';

const result = evolveMesh(PeerIdentity.generate(), /*seed*/ 42, /*generations*/ 30);
console.log(result.fitness.separation, result.promotions);
// every generation emits an ed25519-signed receipt into a hash-chained ledger:
console.log(verifyLedger(result, identityPubHex));   // re-derives chain + signatures
```

Promotion is a **frozen conjunctive gate**: `ALL hard gates pass AND beats the
champion by ≥ PROMOTION_MARGIN`. The champion persists in
`.harness/mesh-flywheel/champion.json`, so each run resumes from the last champion.
To evolve the *same* parameters with the external MetaHarness/Darwin toolchain
instead, see [METAHARNESS.md](METAHARNESS.md).

---

## 7. Defeating false consensus

The bench answers "does fusing experts beat the strongest single expert?" —
honestly. Run it:

```bash
npm run bench:fusion
```

The result (deterministic): fusing *independent* experts beats best-single
(+33.3%), but a confidently-wrong same-lineage cluster drags naive-vote **and**
the mixture's sourceId de-dup *below* best-single. Only lineage-weighted fusion
recovers it:

```ts
import { MixtureState, lineageWeightedWinner, lineageRegistry } from 'radio-moe';

// after folding all experts' frames into `mix`:
const snap = mix.snapshot();
const decision = lineageWeightedWinner(snap, lineageRegistry({
  'llama-a': { provider: 'meta', arch: 'llama', sizeClass: 'L', modelId: 'llama-a' },
  'gemini':  { provider: 'google', arch: 'gemini', sizeClass: 'XL', modelId: 'gemini' },
  'claude':  { provider: 'anthropic', arch: 'claude', sizeClass: 'XL', modelId: 'claude' },
}));
console.log(decision.claimId, decision.effectiveSupport);
```

`lineageWeightedWinner` re-resolves the winning claim by `effectiveSupport` —
greedy min-pairwise independence over supporter provider/arch/size — so N
correlated supporters count far less than N independent ones. Unknown lineage is
**fail-closed** (shares an `'unknown'` bucket, never granted independence). See
[ADR-401](../../../docs/adr/ADR-401-perpetual-intelligence-machine.md).

---

## Mental model & glossary

```
route (Gate, top-k)  →  stream (signed AgentFrames)  →  fuse (MixtureState)
      →  decide (lineageWeightedWinner)  →  authorize (ActionGate)  →  output (signed, shadowed)
                                                                         ↘ evolve (flywheel)
```

| Term | Meaning |
|---|---|
| **Expert** | A capability-tagged producer; `LogitExpert` (mixable) or `TextExpert`/streaming (raced). |
| **AgentFrame** | A typed, ed25519-signed unit of expert output (`claim`/`evidence`/`plan`/`action`). |
| **MixtureState** | Request-scoped fold of authenticated contributions → immutable, replica-stable snapshots. |
| **Independence** | How uncorrelated two supports are. Binary at the gate today; graded via `effectiveSupport` (lineage). |
| **ActionGate** | Releases an action only from independent, admitted, low-risk signed support under a frozen policy. |
| **Flywheel** | Governed evolution of the evolvable params only, inside frozen ceilings, with signed receipts. |
| **RVF trajectory** | A hash-chained, tamper-evident witness package of a run (`packageTrajectory`/`verifyTrajectory`). |

See the [API / SDK Reference](API.md) for every export and its types.
