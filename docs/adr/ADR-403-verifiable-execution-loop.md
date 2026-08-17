# ADR-403 — The verifiable execution loop (promotion closure, actuation, isolation, durable recovery)

- Status: **Accepted** · Item 1 (VerifiedPromotion) **Implemented**; item 4 (durable replay + restart reconstruction) **Partially implemented**; items 2–3 **Accepted-design, pending**
- Date: 2026-08-16
- Updated: 2026-08-16 — added the durable promotion ledger (`ledger` crate) and wired it into `run_canary`; item 4's replay-protection + restart-reconstruction sub-parts are now built and tested.
- Related: ADR-392 (genome/antibody), ADR-394 (cryptographic closure of the promotion path), ADR-400/401 (evolution/PIM). Supersedes nothing.
- Driver: external security review — *"the main missing capability is a verifiable execution loop: Autogenous can model, score, sign, and simulate adaptations, but it cannot prove that the evaluated artifact is exactly what reaches production under enforced limits and recoverable state."*

## Context

The review is correct. Before this ADR, `verify_promotion` did full validation but
returned only `Vec<Reject>`, while `CanaryController::promote(signature: &str)`
accepted **any string** and `run_canary` fed it `sign_hex(candidate_id)`. So the
verification result and the promotion action were not cryptographically linked, and
nothing enforced single-use. The canary stages (1/10/50/100 %) are internal states,
not real traffic. RVM/RVF isolation and durable recovery are concepts, not enforced.

The critical path (per the review, in priority order) is **promotion closure →
enforcement → deployment actuation → durable recovery** — *not* more agent
intelligence.

## Decision

### 1. VerifiedPromotion — a single-use, binding promotion artifact (IMPLEMENTED)

Introduce an **opaque** `VerifiedPromotion` (crate `envelope`) that can be
constructed **only** by successful verification. It binds:
`candidate_hash`, `parent_hash`, `corpus_id`, `receipt_hashes`,
`constitution_hash` (policy version), `controller_pubkey`, `nonce`,
`expires_at`, `rollback_target`.

- `verify_promotion_artifact(...) -> Result<VerifiedPromotion, Vec<Reject>>` runs
  the existing `verify_promotion` engine and, only on **zero rejections AND a valid
  envelope signature**, returns the artifact. There is no public constructor.
- `CanaryController::promote` now takes **`&VerifiedPromotion` + `now`**, not a
  string. It rejects unless: the artifact's `candidate_hash` == this controller's
  candidate, `rollback_target` matches, `now < expires_at`, the final canary stage
  is healthy — and it **consumes the nonce once** (a reused artifact is rejected as
  `replay`). `run_canary` obtains the artifact from verification and hands it in.

This closes the review's P1 #3 / directive #1: *promotion accepts only this
artifact, once.*

### 2. Real deployment actuation (ACCEPTED-DESIGN, pending)

The `DeploymentAdapter` trait must control **actual traffic** at 1/10/50/100 %,
measure **production** outcomes (not injected fitness), **fence concurrent
promotions** (a per-target promotion lock), and **restore the exact parent
artifact** by content hash within the 60 s SLO. `InMemoryAdapter` stays as the
test double; a real adapter (e.g. a gateway/router integration) is the pilot work.

### 3. Enforced isolation (ACCEPTED-DESIGN, pending)

Candidate execution (detector/subprocess) must run under **restricted fs, network,
CPU, memory, wall-time, secrets, and tool permissions** — an RVM enforcement
boundary, not an inherited-authority subprocess. Capability set is declared in the
antibody's `requested_authority` + `prohibited_effects` (already signed over the
full package after the P1 #6 fix) and **enforced** at spawn.

### 4. Durable recovery (PARTIALLY IMPLEMENTED)

A **transactional promotion ledger** (append-only, fsync'd), **persistent replay
protection** (the consumed-nonce set survives restart), **restart reconstruction**
of controller state, and a **durable checkpoint store**. A process crash must lose
no governance state and permit no duplicated action.

**Built (crate `ledger`, wired into `run_canary`):** an append-only, fsync'd,
witness-hash-chained log of every committed promotion. `PromotionLedger::open`
replays and cryptographically verifies the whole chain (signatures + prev links),
rejecting any tampered/forged/reordered line, and rebuilds the consumed-nonce set
— restart reconstruction with no manual edits. `record_promotion` fsyncs before
advancing in-memory state and refuses an already-recorded nonce, so a promotion is
single-use **across restarts and across fresh controllers**, not just in-process.
An acceptance test proves a durably-committed promotion cannot be replayed by a new
controller after a simulated restart (item-1 in-process single-use alone would not
catch that).

**Still pending for item 4:** durable checkpoint of *mid-rollout* canary state
(so a crash at, say, the 50 % stage resumes rather than restarts), and making the
ledger the single authoritative nonce store the `CanaryController` itself consults
(today `run_canary` consults it around the controller's own in-process set).

## Acceptance test (the review's, verbatim intent)

Inject a signed incident → generate a candidate → obtain **two independent
receipts over the same hashed corpus** → issue a **single-use** promotion token →
canary **real traffic** through 1/10/50/100 % → inject a regression → **restore the
exact parent within 60 s** → **restart every controller** and **reconstruct the
complete authorized state** with no manual edits.

Status against it after this ADR:
- Two independent receipts over a hashed corpus — **enforced** (ADR-394 + P1 #4
  worst-case-across-judges fix: every pinned judge's receipt must pass).
- Single-use promotion token — **enforced** (item 1, this ADR + tests).
- Restart reconstruction (of the authorized-promotion state) — **built** (item 4
  ledger): reopening reconstructs the consumed-nonce set + promotion history and a
  replayed promotion is refused post-restart.
- Real-traffic canary, 60 s exact-parent restore, mid-rollout crash-resume —
  **pending items 2 & 4-remainder**; the in-memory adapter proves the state machine
  and the timed rollback SLO, not real traffic; the ledger persists committed
  promotions but not in-flight canary stage state.

## Consequences

- **Positive**: the verified→promoted link is now cryptographic and single-use — a
  candidate cannot be promoted except by an artifact that provably passed
  verification, bound to that exact candidate/parent/corpus/policy, once.
- **Honest scope**: items 2–4 are multi-week platform work (the review sized the
  whole pilot at 3–5 engineers × 12–20 weeks). This ADR does the closure head now
  and specifies the rest; it does not claim they are built.
- **Fence**: no deployment, no production traffic, no publish is performed by this
  ADR.
