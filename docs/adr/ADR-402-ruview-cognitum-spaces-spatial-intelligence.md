# ADR-402 — RuView + Cognitum Spaces: the spatial-intelligence layer

- Status: **Proposed** (design-only — RuView & Cognitum Spaces are external
  repos/products; this ADR specifies the layer and its seam onto the mesh, it
  does NOT claim implementation in `radio-moe`)
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

**Boundary (honest):** RuView, RuField, and Cognitum Spaces are *not* in this
repository. What already exists here is the **fusion + governance substrate**
they plug into — the streaming mixture (`mixture.ts`), the independence-weighted
quorum + action gate (`lineage-independence.ts`, `action-gate.ts`), signed
failover (`failover.ts`), the witnessed trajectory ledger (`rvf-trajectory.ts`),
and the midstream observation adapter (`midstream-adapter`). This ADR defines
the contract so the perception layers drop in without redesign.

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
| Raw sensing data stays local | sovereign-peer boundary (ADR-401 cap 6) | **Gap (design-only)** |
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
   per-field rejection reason. Optional sensor-health floor. `confidenceTier`
   maps ADR-402 §5 (low → update-world-model, medium → request-more-sensing, high
   → authorized-workflow), with the top tier documented as *eligibility only* —
   an authorized action still requires independent corroboration at the
   `ActionGate` (graded quorum). Proven by `test/observation.test.ts` (6 tests).
3. **Remaining ADR-402 loop items** (this ADR is otherwise a specification): the
   timed failover bench (**done**, shared with ADR-401), the fusion false-alert
   bench (**done** — `bench-false-alert.ts`), and the sovereign-peer local-data
   boundary (the one still open, part of ADR-401 cap 6).

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
