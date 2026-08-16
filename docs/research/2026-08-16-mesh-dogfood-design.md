# Dogfood: the mesh designed (and reviewed) its own next build items

- Date: 2026-08-16 · Run: `examples/mesh-dogfood.ts` (dogfood-1)
- Pod: architect[claude -p] · implementer[codex exec] · reviewer[claude -p] —
  heterogeneous backends, deliberately decorrelated briefs (practicing research
  item 1 while designing it). 26 ed25519-signed frames · RVF root verified.
- Implemented in: `src/agent-frame.ts` (StreamNonceGate), `src/evidence-feeds.ts`,
  `src/lineage-independence.ts` — then REVIEWED by the mesh (gemini-3.7-flash via
  OpenRouter, dogfood-review-1), which found two real bugs in verifyCert
  (unauthenticated lineages/signer duplication; over-constrained all-pairs check),
  both fixed with attack tests.

## The mesh's designs (verbatim capture)

```
dogfood pod: architect[claude](57639a62c311c2b5), implementer[codex](270a5aaba0968079), reviewer[claude](65a9133c2458877a)

── 26 signed frames in 67.3 s ──

### architect [claude] — DESIGN
**Design: receiver-issued stream nonce, signed inside the frame.**

On stream open, the consumer generates `streamNonce = randomBytes(16).toString('hex')` and sends it in its subscribe/hello envelope. The producer echoes it in every frame:

```ts
export interface AgentFrame {
  // ...existing fields
  streamNonce: string; // consumer-issued, 16B hex, per stream instance
}
```

Because ed25519 signs the canonical frame-without-signature, the nonce is under the signature — no wire-format change beyond the field.

**Who checks:** the frame verifier at the consumption point (mesh gate / action-gate), not the transport. It rejects unless `frame.streamNonce` equals the nonce it issued for this stream, and `(streamNonce, agentId, step)` is unseen.

**Soundness:** the nonce is receiver-chosen and unpredictable, so a frame captured on stream A cannot verify on stream B — the attacker can't produce a signature covering B's nonce without the signing key. Envelope `eventId`/`senderSequence` protect single hops; the in-frame nonce binds end-to-end across relays, within TTL or after receiver restart.

🧠 RuvNet Brain jumped in · guidance only, no source read · v4.0.58-dev 

(frames: 11, all signed: true)

### implementer [codex] — DESIGN
```ts
type EvidenceRef = {
  id: string; relevance: number; stance: -1 | 0 | 1;
};
type Feed = {
  mode: "top" | "bottom" | "contrastive";
  refs: readonly EvidenceRef[];
};

function partitionEvidence(
  pool: readonly EvidenceRef[],
  expertIds: readonly string[],
  width: number,
): ReadonlyMap<string, Feed>;
```

Implementation contract: deduplicate `pool` by `id`; sort experts lexicographically; require `pool.length >= expertIds.length * width`. Cycle modes by expert index. Rank candidates by relevance descending for `top`, ascending for `bottom`, and alternating strongest positive/negative stance for `contrastive`; break every tie by `id`. Each expert takes the first `width` globally unused candidates.

This is pure, input-order-independent, and produces disjoint reference sets, so `sourceIds` and resulting `evidenceHashes` cannot accidentally manufacture correlated action-gate support. Reject insufficient pools instead of silently reusing evidence.

🧠 RuvNet Brain jumped in · guidance only, no source read · v4.0.36 · v4.0.58-dev staged, restart to load 

(frames: 3, all signed: true)

### reviewer [claude] — DESIGN
```ts
interface ModelLineage { provider: string; arch: string; sizeClass: 'S'|'M'|'L'|'XL'; modelId: string }
interface ActionSupport { agentId: string; principalId: string; lineage: ModelLineage; sourceIds: string[]; signature: string }

// Tunable, hot-reloadable — correlation claim unverified, never freeze
interface IndependenceWeights { sameProvider: number; sameArch: number; sameSize: number; sourceJaccard: number } // default {0.4,0.35,0.1,0.15}

function pairIndependence(a: ActionSupport, b: ActionSupport, w: IndependenceWeights): number {
  if (a.lineage.modelId === b.lineage.modelId) return 0;
  let s = 1;
  if (a.lineage.provider === b.lineage.provider) s -= w.sameProvider;
  if (a.lineage.arch === b.lineage.arch) s -= w.sameArch;
  if (a.lineage.sizeClass === b.lineage.sizeClass) s -= w.sameSize;
  s -= w.sourceJaccard * jaccard(a.sourceIds, b.sourceIds);
  return Math.max(0, s);
}
// Gate: effectiveSupport = greedy-select supports maximizing Σ min-pairwise independence; require ≥ threshold (replaces count ≥ 2 distinct modelIds).
```

Quorum: completion commits only when k of n designated verifier agents counter-sign the AgentFrame's canonical bytes (detached ed25519 signatures aggregated in a `CompletionCert {frameHash, signers[], sigs[]}`), with the k signers themselves required to meet a minimum pairwise-independence score so a same-lineage clique can't self-quorum.

🧠 RuvNet Brain jumped in · guidance only, no source read · v4.0.58-dev 

(frames: 12, all signed: true)

RVF trajectory: entries=26 root=b16aed5147aecc5f… verifies=true
```

## The mesh's review of the implementation (gemini-3.7-flash)

> Verdict: BROKEN — (1) counterSign only signs frameHash: one valid signature
> repeated k times with fabricated diverse lineages bypasses clique resistance;
> (2) all-pairs independence check falsely rejects certs containing a valid
> k-subset. (effectiveSupport and partitionEvidence correct.)

**Both fixed**: attestations now sign frameHash ‖ signer-pubkey ‖ canonical(lineage),
signers dedupe before counting k, and verification accepts any independent
k-subset (n ≤ 16). Attack tests: duplicated-signer+fake-lineage blocked;
fabricated lineage breaks the attestation; extra correlated signer tolerated.
