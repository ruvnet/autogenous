# ADR-398 — Applications, commercialization, and development-loop integration

- Status: Accepted (product/design record)
- Date: 2026-08-16
- Decision owners: Autogenous maintainers
- Related: ADR-395, ADR-396, ADR-397

## Context

The Autogenous Streaming Mixture of Agents (ADR-397) enables applications where no
single agent, model, organization, or data source is sufficient, but centralizing
all intelligence or authority is undesirable. The strongest applications are **not
chatbots** — they are real-time distributed decisions requiring specialist
intelligence, evidence, resilience, and controlled action. This ADR records the
application map, commercialization order, the dominant failure mode, and — because
it is the nearest-term, lowest-risk wedge — the concrete integration into the
development loop and agentic workflows.

## Development-loop and agentic-workflow integration (the near-term wedge)

Application #2 below (distributed software engineering) is realized directly on
this repo's primitives:

- Each workstream is a streaming expert peer wrapping a real backend —
  `claude -p --output-format stream-json` or `codex exec --json`
  (`src/streaming-experts.ts`) — emitting typed `AgentFrame`s (claim / evidence /
  plan / action), not prose.
- Discoveries alter the **shared trajectory immediately**: a security peer's
  `evidence` frame can stop an implementation peer before it builds on an unsafe
  assumption, unlike conventional coding swarms that only merge at the end.
- `endlessMixLoop` runs the peers concurrently and folds each frame the instant it
  arrives; AgentRadio carries route/awareness/cancellation metadata only.
- The action gate (`Execute(a) = Admissible(a) ∧ IndependentSupport(a) ≥ 2 ∧
  Risk(a) < τ`, ADR-397) governs anything with side effects — commits, merges,
  deploys — so intelligence combines without authority combining.

Applications: repository-wide implementation, continuous code review, CI-failure
remediation, dependency migration, security-patch generation, architecture
conformance, production-incident debugging. **Expected benefit: 25–50 % lower
completion time on tasks with genuinely independent workstreams; simple tasks do
not benefit and may cost 2–4×.**

## Application map

1. **Autonomous cybersecurity response** *(best initial enterprise application)* —
   specialist peers inspect network telemetry, identity events, endpoint activity,
   app logs, threat intel, agent tool calls; MidStream fuses claims/evidence/
   confidence/containment proposals while the incident unfolds. Action gate example:
   `IsolateHost = MalwareConfidence > 0.95 ∧ IndependentPeers ≥ 2 ∧
   BusinessCriticality < τ`. Value: detection-to-containment from 15–60 min to
   < 60 s; no single compromised detector can isolate infrastructure; every action
   retains signed evidence + provenance.
2. **Distributed software engineering** — see the integration section above.
3. **Sovereign enterprise intelligence** — each department keeps private data local
   (legal contracts, finance transactions, security incidents, HR, ops telemetry);
   peers exchange bounded claims + evidence references, not datasets. Enterprise-wide
   answers with no central data lake; reduced data movement and breach exposure.
4. **Cross-organization fraud detection** — banks/insurers/marketplaces/telecom
   stream privacy-preserving risk observations (entity hash, behavioral pattern,
   confidence, time window, evidence commitment, jurisdiction, expiry, signature).
   The mixture detects patterns invisible to any single org. Critical control:
   prevent one participant from poisoning shared risk scores.
5. **Real-time clinical decision support** — peers evaluate history, monitoring,
   interactions, imaging, guidelines, local protocols; continuously updated
   recommendation. Remains **decision support, not autonomous treatment** (human
   approval, validated models, regulated evidence, full provenance).
6. **Spatial intelligence** *(maps to RuView / Cognitum)* — peers specialize in WiFi
   sensing, radar, BLE, cameras, environmental sensors, building telemetry, network
   state, historical world models; each streams uncertain spatial claims (e.g.
   `occupancy: room 204, confidence 0.91, source WiFi CSI, valid 750 ms, evidence
   hash …`), fused into a live world state.
7. **Edge and network operations** *(Cognitum + Nutanix)* — routers/gateways/APs/
   controllers become expert peers contributing congestion/interference/security/
   demand/health/inference-capacity/energy intelligence; the network collectively
   decides placement, channels, routing, containment.
8. **Distributed robotics** — shared trajectory without routing every observation
   through one controller. Safety-critical control loops stay local; the mixture
   governs planning/coordination at ~10–500 ms, **not** motor control at µs.
9. **Financial intelligence** — peers process market data, news, exposure,
   counterparty risk, regulation, alt-data, execution conditions; trading authority
   stays separate and constrained. Direct autonomous trading requires deterministic
   limits **outside** the agent system.
10. **Scientific discovery** — peers specialize in literature, datasets,
    simulations, mathematical verification, experimental design, instrumentation; a
    new simulation result immediately changes another peer's proposed experiment;
    signed evidence reconstructs every conclusion.
11. **Expert intelligence exchange** — operators run specialist peers and charge per
    *accepted contribution* by marginal value: `Payment_i = V(Z_t) − V(Z_t \ F_i)`.
    Attribution and gaming-resistance remain research problems.

## Best commercialization order

| # | Application | Buyer | Sales cycle | Technical risk |
|---|---|---|---|---|
| 1 | Agent + MCP security firewall | Enterprise AI platform teams | 2–6 mo | Moderate |
| 2 | Distributed software engineering | Engineering orgs | 1–3 mo | Low–moderate |
| 3 | Sovereign enterprise intelligence | Regulated enterprises | 6–18 mo | Moderate |
| 4 | Spatial intelligence fusion | Telecom, elder care, building automation | 6–18 mo | High (sensing accuracy env-dependent) |
| 5 | Robotics, medicine, finance | Regulated operators | 12–36 mo | Very high |

## Dominant failure mode — false consensus

Multiple agents frequently share the same model, training data, retrieval source,
or flawed assumption. Three agreeing agents may represent one correlated error, not
three independent confirmations. The fix: measure evidence independence, model
diversity, source overlap, and historical calibration **before** counting quorum.

## Acceptance test

Choose a task requiring three independent private data sources. The mixture must:
outperform the strongest single peer by **≥ 10 %**; reduce time-to-first-correct-
decision by **≥ 25 %**; reconstruct every visible claim to signed evidence; and
execute **zero** external actions without the required independent authority quorum.
