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
- [8. Fail-closed boundaries (admit, verify, disclose)](#8-fail-closed-boundaries-admit-verify-disclose)
- [9. Cognitum Spaces + OAuth (deployed spatial world model)](#9-cognitum-spaces--oauth-deployed-spatial-world-model)
- [Mental model & glossary](#mental-model--glossary)

---

## 1. Install & verify

```bash
cd packages/radio-moe
npm install
npm test              # 116 offline, deterministic tests
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

By default independence at the gate is **binary** (distinct modelId ∧ disjoint
sourceIds) via `independentSupportSet`. The graded, lineage-aware upgrade is now
available as an **opt-in** `gradedIndependence: { minimumEffectiveSupport }`
option — a strictly-tightening AND-gate, so a same-provider/arch clique that
passes the binary count still fails the lineage-discounted quorum (supports may
carry a signed `lineage`; absent lineage is fail-closed). It can only tighten,
never loosen; see § 7 for the underlying `effectiveSupport`.

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

## 8. Fail-closed boundaries (admit, verify, disclose)

Three more guards wrap the pipeline's edges. All are opt-in, composable, and
**fail-closed** — the default when something is missing or unproven is to reject,
not to trust.

**Admit an observation before it becomes evidence** (ADR-402). A perception is
inadmissible unless every required field is present and current:

```ts
import { admitObservation, confidenceTier } from 'radio-moe';

const d = admitObservation({
  sourceId: 'csi-3', location: 'room-204', kind: 'motion-changed', value: { delta: 'stopped' },
  confidence: 0.7, privacyClass: 'restricted', calibrationVersion: 'cal-2026-08',
  issuedAt: now - 1, expiresAt: now + 30_000,
}, now, { minSensorHealth: 0.5 });
// d.admissible === false, d.rejection === 'missing-calibration' | 'expired' | 'unhealthy-sensor' | …
confidenceTier(obs); // 'update-world-model' | 'request-more-sensing' | 'authorized-workflow'
```

The `authorized-workflow` tier is *eligibility only* — an actual action still
needs independent corroboration at the `ActionGate`.

**Verify an outcome before a durable write** (ADR-401 Dec 2 — the one
false-consensus mitigation with a measured effect size). A write is admitted only
when independent **external** verifiers (not the outcome's producers) affirm it and
no external verifier refutes it:

```ts
import { outcomeHash, signOutcomeVerdict, admitDurableWrite } from 'radio-moe';

const hash = outcomeHash(outcome);
const verdicts = [ signOutcomeVerdict(v1, { outcomeHash: hash, verifierId: v1.peerId, stance: 'affirm', verified: true, reason: 'checked' }) ];
const gate = admitDurableWrite(hash, verdicts, { trustedVerifiers, contributorIds, minAffirmations: 2 });
// gate.admit === false with rejection 'no-external-verifier' | 'insufficient-affirmation' | 'refuted' | 'insufficient-independence'
```

**Disclose across an org boundary without leaking raw data** (ADR-401 cap 6). A
signed disclosure carries only the claim, a confidence, and evidence *digests* at
or below a privacy ceiling — never raw payloads:

```ts
import { discloseFinding, verifyDisclosure } from 'radio-moe';

const disclosure = discloseFinding(peer, finding, { maxPrivacyClass: 'internal' }, now);
// restricted/sensitive evidence is dropped; finding.raw and evidence payloads never appear
verifyDisclosure(disclosure, peer.publicKeyDer.toString('hex')); // receiver checks provenance + confidence
```

---

## 9. Cognitum Spaces + OAuth (deployed spatial world model)

ADR-402's Cognitum Spaces is real and deployed on GCP. A user signs in with their
Cognitum identity and the mesh reads live spatial state under that identity —
mapping each Spaces envelope into an `Observation` that flows through the same
fail-closed admission (§8).

```ts
import { CognitumIdentityClient, sessionAuth, CognitumSpacesClient, spacesEnvelopeToObservation, admitObservation } from 'radio-moe';

// 1) The user signs in (browser bootstrap) then the CLI exchange completes it →
//    a Bearer session. exchangeSession sends the request + consumes the token;
//    it never holds the user's password.
const identity = new CognitumIdentityClient();
const session = await identity.exchangeSession({ clientId: 'my-cli', installCtxHash: '<hash>' });

// 2) Use Cognitum services under the user's identity.
const spaces = new CognitumSpacesClient({ auth: sessionAuth(session) }); // or apiKeyAuth(() => process.env.COGNITUM_API_KEY)
const { data, boundary } = await spaces.listSpacesResult();
console.log(boundary?.excluded); // raw_csi, recordings, pose_frames, … stay at the edge — never in the cloud

// 3) A Spaces envelope becomes an admissible Observation (or is rejected fail-closed).
// const obs = spacesEnvelopeToObservation(env); admitObservation(obs, Date.now());
```

Live-verified: `GET /v1/spaces` returns 200 with a valid `cog_` key, and the
service reports the cloud/edge privacy `boundary` — ADR-402's "raw sensing stays
local", enforced on the running service. See
[ADR-402](../../../docs/adr/ADR-402-ruview-cognitum-spaces-spatial-intelligence.md).

---

## Mental model & glossary

```
observe (admitObservation)  →  route (Gate, top-k)  →  stream (signed AgentFrames)
    →  fuse (MixtureState)  →  decide (lineageWeightedWinner)  →  authorize (ActionGate)
    →  persist (admitDurableWrite)  →  output (signed, shadowed)  →  disclose (discloseFinding)
                                                                        ↘ evolve (flywheel, promoteAuthorized)
```
Every stage has a signed, fail-closed, independence-aware guard.

| Term | Meaning |
|---|---|
| **Expert** | A capability-tagged producer; `LogitExpert` (mixable) or `TextExpert`/streaming (raced). |
| **AgentFrame** | A typed, ed25519-signed unit of expert output (`claim`/`evidence`/`plan`/`action`). |
| **MixtureState** | Request-scoped fold of authenticated contributions → immutable, replica-stable snapshots. |
| **Independence** | How uncorrelated two supports are. Binary at the gate by default; opt-in graded via `effectiveSupport` (lineage). |
| **ActionGate** | Releases an action only from independent, admitted, low-risk signed support under a frozen policy. |
| **Flywheel** | Governed evolution of the evolvable params only, inside frozen ceilings, with signed receipts. |
| **RVF trajectory** | A hash-chained, tamper-evident witness package of a run (`packageTrajectory`/`verifyTrajectory`). |

See the [API / SDK Reference](API.md) for every export and its types.
