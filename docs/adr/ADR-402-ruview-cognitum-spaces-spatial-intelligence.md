# ADR-402 — RuView + Cognitum Spaces: the spatial-intelligence layer

- Status: **Accepted** (legacy and versioned read-side adapters plus the
  fail-closed seam are implemented in the `radio-moe` 0.3.0 release candidate;
  versioned API deployment, npm publication, write-side synchronization, and
  the 30-day operational acceptance test remain separately gated rollout work)
- Date: 2026-08-16
- Related: ADR-401 (Perpetual Intelligence Machine — this is capability 8
  expanded), ADR-397 (streaming mixture), ADR-399 (midstream, RVM/RVF),
  `action-gate.ts`, `failover.ts`, `rvf-trajectory.ts`, `mixture.ts`

## Context

The PIM (ADR-401) lists *real-time spatial intelligence* as a Gap. This ADR
specifies it as its own layer: **RuView gives the PIM perception; Cognitum
Spaces gives it a persistent spatial world model; the agent mixture interprets
change, predicts what happens next, and coordinates governed actions.**
Together they form a continuously-learning intelligence layer for **physical
environments**.

**Repository boundary:** RuView and Cognitum Spaces are external products. This
repository owns the read adapter, typed observation admission, derived-lineage
handling, fusion, and governance substrate they plug into — the streaming
mixture (`mixture.ts`), independence-weighted quorum + action gate
(`lineage-independence.ts`, `action-gate.ts`), signed failover (`failover.ts`),
and witnessed trajectory ledger (`rvf-trajectory.ts`). It does not own OAuth
issuance, the Spaces resource server, RuView sensing, or production deployment.

**Update (2026-08-17) — the deployed read surface and adapter are verified.**
`packages/radio-moe/src/cognitum-spaces.ts` connects to the gateway route
`GET /v1/spaces`, validates the response contract, and maps a Cognitum Spaces
Envelope to a derived radio-moe `Observation`. Authentication is either a
compatibility `cog_` key read from `COGNITUM_SPACES_API`, or a Cognitum OAuth
access token issued to the RuView public PKCE client with audience/client
`ruview` and scope `spaces:read`. A `cognitum-cli` session-exchange token is a
different credential and MUST NOT be reused for Spaces.

The live API-key compatibility test returned 200 and a service `boundary` that
excludes `raw_csi`, `cir`, `rf_tensors`, `recordings`, `pose_frames`,
`vital_waveforms`, and `identity_observations` from cloud synchronization. The
test is gated on `COGNITUM_SPACES_API`; secret values are never logged or
committed. OAuth rollout is coordinated by Cognitum API ADR-094 and RuView
ADR-325 and is not claimed live until those deployments are verified.

The adapter preserves tenant, message, sequence, and provenance lineage.
Spaces-derived state is explicitly `derived` and is capped at
`update-world-model`, regardless of confidence, preventing a cloud recollection
from returning as apparently independent workflow authority. Missing
confidence remains unknown (`NaN`) and missing `modelVersion` remains missing
calibration; provenance is never used as a calibration substitute.

**Update (2026-08-19) — the full versioned read contract is implemented and
locally validated.** Cognitum API ADR-101 defines read-only pages for `sites`,
`buildings`, `floors`, `spaces`, `zones`, anonymous `entities`, semantic
`events`, and `alerts`. `CognitumSpacesClient.listSpatial` binds the collection
to a fixed path, accepts a 1–100 limit and opaque bounded cursor, requires a UUID
workspace for compatibility API keys, and relies on the signed workspace for
RuView OAuth. It validates schema `1.0`, hierarchy parents, entity anonymity,
event/alert fields, confidence, time, IDs, page cursors, the HomeCore boundary,
and recursive byte/depth/node/array/object/string/raw-field limits.

`spatialResourceToObservation` preserves tenant/message/sequence lineage and
marks the result derived before it reaches `admitObservation`. It uses only
explicit provenance source/model/digest fields. Missing calibration, source,
confidence, or semantic expiry remains missing and therefore fails closed. A
retention deadline is never reinterpreted as observation freshness. The client
still exposes no write, policy approval, command, or actuator method.

The locally green versioned adapter is not yet a production claim. Production
continues to mean the legacy `/v1/spaces` evidence below until the Cognitum API
deployment workflow, index/TTL readiness, and OAuth readback complete.

## Functional architecture

### 1. RuView observes
Converts WiFi CSI/CFR, BLE, radar, network telemetry, cameras, and
environmental sensors into **timestamped observations** (person detected, zone
occupied, motion changed, device moved, RF anomaly, air quality degraded,
network behavior changed). **Every observation MUST carry: source identity,
location, confidence, privacy class, calibration version, and expiry.** (These
become required fields on the inbound frame — the observation-side analogue of
`AgentFrame`; RuField owns the typed schema.)

### 2. Cognitum Spaces maintains the world model
Converts observations into **persistent entities and relationships**:
`Building > Floor > Room > { Person, Device, Asset, EnvironmentalState,
NetworkState }`. The load-bearing distinction: **RuView reports an observation;
Spaces maintains *belief* about reality.**

    Belief(e, t) = Fuse(Observations, History, Context, Uncertainty)

Spaces therefore knows not only *that* motion stopped, but that an occupied room
became unexpectedly inactive, that the resident normally moves at this hour, and
that the evidence is incomplete.

### 3. MidStream carries live cognitive state
Incremental hypotheses rather than completed answers — e.g. RuView: "motion
stopped" · Routine: "differs from normal pattern" · Network: "sensor
connectivity healthy" · Environmental: "temperature rising" · Safety: "evidence
insufficient for emergency." Target time-to-useful-interpretation for **local**
events: **250–750 ms** (vs several seconds for complete-answer waiting). Maps to
the mesh's existing continuous-fusion path (`streaming-experts.ts` → `mixture.ts`).

### 4. The mixture continuously combines experts
Changing weights over spatial, behavioral, network, policy, and safety agents,
e.g.:

    Decision = 0.35·Spatial + 0.25·Routine + 0.20·SensorHealth
             + 0.15·Safety  + 0.05·Environmental

**Weights reflect measured reliability for that building and event class — not
model confidence alone.** This is exactly ADR-401 capability 3's
`w=q·t·r/(c·l)` specialized to a space; the per-space reliability signal is the
`t` (trust) term that ADR-401 marks as the current gap.

### 5. Cognitum governs action
The fused conclusion is evaluated against tenant policy, privacy rules, consent,
capabilities, and action thresholds. Confidence tiers:
- **low** → may update the world model only;
- **medium** → may *request additional sensing*;
- **high + independently corroborated** → may trigger an authorized workflow.

RVM constrains execution; RVF packages agent+policy+model+memory+witness
history; **every consequential action produces a receipt.** Maps to
`action-gate.ts` (`independentSupportSet` = the "independently corroborated"
requirement) + `rvf-trajectory.ts` (the receipt).

### 6. Outcomes improve the space
Correct alerts → contributing observations + expert config gain calibrated
value; false alerts → routing weights, thresholds, or sensor placement revised
through **governed** evaluation (the flywheel, ADR-400). The building becomes
better understood over time **without uncontrolled self-modification.**

## Primary failure mode + the structural-uncertainty fix

**The dominant risk: Spaces turns weak RuView observations into
authoritative-looking world state.** RuView accuracy varies significantly by
task and environment — especially pose, vital signs, and safety events.

**Fix — make uncertainty structural.** No observation becomes a fact without
**calibration, expiry, sensor health, and independent corroboration. Unknown
must remain unknown.** This is enforced at the seam: an observation missing any
required field (calibration version / expiry / privacy class / confidence) is
inadmissible as evidence, and the high-confidence action tier requires
independent corroboration (`independentSupportSet` ≥ 2 uncorrelated sources) —
the same false-consensus guard ADR-401 makes constitutional, applied to sensors.

## Product decomposition (the clean boundary)

| Layer | Responsibility |
|---|---|
| RuView | Physical & RF perception |
| RuField | Typed observations, confidence, provenance, privacy |
| Cognitum Spaces | Spatial entities, relationships, history, belief state |
| MidStream | Live observation & agent-contribution streams |
| RuVector | Spatial memory, similarity, graph reasoning, routing |
| RuFlo | Agent coordination & workflows |
| MetaHarness | Configuration generation & governed improvement |
| Radio | Local agent awareness & coordination metadata |
| RVF | Portable intelligence & policy artifact |
| RVM | Capability enforcement & witnessed execution |
| Cognitum One | Tenant governance, deployment, operations, commercial control |

## What this enables (with honest bounds)

1. **Adaptive elder care** — learn routines locally, detect meaningful
   deviations, gather corroborating evidence, escalate progressively. **Initially
   wellness/operational assistance only — NOT medically-reliable fall or
   vital-sign detection.**
2. **Self-optimizing buildings** — coordinate occupancy/HVAC/lighting/air-
   quality/security/energy by observed use. **Realistic target: 10–25% energy
   reduction in intermittently-occupied commercial space, subject to building
   type & control access.**
3. **Spatial security** — unified cyber+physical anomaly detection (RF change +
   device identity/traffic + "is this expected for this location/time?").
4. **Retail/venue intelligence** — traffic flow, congestion, queue formation,
   zone engagement **without persistent personal identity.**
5. **Industrial operations** — joint reasoning over personnel location,
   equipment state, RF telemetry, environment, maintenance history. **Safety-
   critical control must remain independently certified.**
6. **Persistent digital twins** — an *active* twin that observes, reasons,
   predicts, tests interventions, and retains verified outcomes (vs a database/
   visualization).
7. **Federated spatial intelligence** — each home/building/vehicle/venue is a
   sovereign peer; spaces exchange **permitted findings, not raw sensor
   streams** (e.g. a hotel shares aggregate occupancy demand with an energy
   operator without disclosing individual movement). Depends on ADR-401
   capability 6 (cross-org), also a Gap.

## Acceptance test

> Deploy three sensor modalities in ten rooms for 30 days. Passes iff it:
> (1) maintains **≥95% calibrated presence accuracy**, (2) **detects peer
> failure within 5 seconds**, (3) **reduces false alerts by 50% through agent
> fusion**, (4) **keeps raw sensing data local**, and (5) **produces a complete
> authorization + evidence receipt for every external action.**

| Condition | Substrate that instruments it | Status |
|---|---|---|
| ≥95% calibrated presence accuracy | RuView calibration + RuField typed obs | **External (RuView) — bench gap** |
| Peer-failure detection <5s | `bench-failover.ts` (shared with ADR-401) | Protocol recovery **measured** (p50 0.34 ms at 30% loss, ≈8000× under budget); sensor/network detection latency is the external part |
| 50% false-alert reduction via fusion | `bench-false-alert.ts` + `test/false-alert.test.ts` (corroboration fusion vs no-fusion any-sensor baseline) | **Built & measured** — 58.3% reduction (60%→25%), detection retained 100% |
| Raw sensing data stays local | Cognitum Spaces `boundary` (live) + sovereign-peer boundary (ADR-401 cap 6) | **Verified on the deployed read service** — `/v1/spaces` excludes raw_csi/cir/rf_tensors/recordings/pose_frames/vital_waveforms/identity_observations from cloud synchronization; write-side enforcement remains a separate gate |
| Complete receipt per external action | `action-gate.ts` + `rvf-trajectory.ts` | Built (action side); wire perception provenance in |

## Decision

1. **Accept the layered decomposition and the seam contract** above as the
   target architecture; the mesh substrate (fusion, quorum, gate, failover,
   ledger) is the integration point, and RuView/RuField/Spaces are the
   perception/world-model layers that plug into it.
2. **Structural uncertainty is non-negotiable at the seam** — **BUILT**
   (`src/observation.ts`, `admitObservation`). The inbound observation schema
   requires source identity, location, kind, confidence, privacy class,
   calibration version, and a bounded/current expiry window; missing or malformed
   any of these → **inadmissible** (fail-closed — unknown stays unknown), with a
   per-field rejection reason. Optional sensor-health floor. Derived lineage is
   runtime-validated and Spaces recollections are restricted to world-model
   updates, closing the feedback-laundering path. `confidenceTier`
   maps ADR-402 §5 (low → update-world-model, medium → request-more-sensing, high
   → authorized-workflow), with the top tier documented as *eligibility only* —
   an authorized action still requires independent corroboration at the
   `ActionGate` (graded quorum). Proven by `test/observation.test.ts` (6 tests).
3. **Credential boundaries are explicit.** The generic Cognitum CLI session
   helper remains available only to services accepting the `cognitum-cli`
   audience. Spaces requires RuView PKCE + `spaces:read`; compatibility API keys
   remain read from a Spaces-specific environment variable.
4. **Versioned spatial read:** the hierarchy/event/alert adapter, strict page
   validator, and derived-observation mapper are **built and locally tested**.
   Production remains gated on Cognitum API ADR-101 deployment/readback.
5. **Release authority:** `radio-moe` 0.3.0 may publish only from the main-only
   `radio-moe npm release` workflow. It rebuilds, typechecks, tests, audits,
   packs and smoke-imports the exact tarball, verifies its digest, and publishes
   with npm provenance. A local `npm publish` is not release evidence.
6. **Remaining ADR-402 loop items:** the timed failover bench (**done**, shared
   with ADR-401), the fusion false-alert bench (**done** —
   `bench-false-alert.ts`), the sovereign-peer local-data boundary (open under
   ADR-401 capability 6), and the explicitly authorized write-side exchange.

## Consequences

- **Positive**: the spatial product has a crisp boundary and a falsifiable
  30-day acceptance test; the mesh's existing governance guards (independent
  corroboration, signed receipts, fenced failover) are reused, not reinvented.
- **Negative / risk**: the perception layer is external and its accuracy is the
  weakest link; this ADR's entire posture is to prevent weak perception from
  becoming authoritative belief — "unknown must remain unknown."
- **Fence**: no deployment, no sensor claim, no medical/safety-critical claim.
  Elder-care and industrial-safety framings are explicitly bounded to
  non-certified assistance until independent validation.
