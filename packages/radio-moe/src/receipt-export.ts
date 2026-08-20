//! Receipt-compatible export of governed-promotion evidence (PIR WP8,
//! ruvnet/autogenous#10).
//!
//! Maps a `promoteAuthorized` promotion (ADR-401 Decision 3) onto the
//! `ruflo.flywheel-receipt/v1` shape defined by the witness/receipt
//! contract on ruflo `main` (`v3/docs/spec/witness-receipt-contract.md`,
//! merged via ruvnet/ruflo#3067; tracked by ruvnet/ruflo#3066), so a
//! promotion can be verified — and anchored — by any contract consumer
//! without reading this repo's source.
//!
//! # Field mapping (mesh-evolve → receipt)
//!
//! | receipt field | source |
//! |---|---|
//! | `candidatePolicy` | `EvolvableParams`, fractional knobs as decimal strings (`policySchemaVersion` = `autogenous.mesh-evolve-params/v1`) |
//! | `candidateId` / `baselineRef` | `SHA-256(JCS(policy))` of candidate / champion |
//! | `pairedOutcomes` | the three frozen-bench separation terms, per params: diverse-pair margin, stack margin, mixed-trio margin |
//! | `heldOutDeltas` | per-task `candidate − champion`, computed from the ENCODED scores (contract gap G5 lesson: a verifier only ever has the encoded form) |
//! | `statistics` | the normative paired bootstrap (ADR-322C §Update 2026-08-19) over those deltas — seed, LCG, order statistic, scale-12 encoding all per spec |
//! | `gates` | the four ADR-401 conjuncts: `better`, `safe`, `authorized`, `reversible` |
//! | `termVerification` | honest grades: `better`/`safe` are `recomputed`; `authorized`/`reversible` are `trusted-assertion` naming the governed loop as attestor |
//! | `safetyEnvelopeRef` | content ID of the constitutional `CEILINGS` |
//! | `decision` | the CONTRACT's rule (`statistics.accepted && all gates`), which may be `rejected` even when this repo's margin rule promoted — the export states what the 322C gate would say, never relabels it |
//!
//! # Honest gaps (enumerated on ruvnet/autogenous#10)
//!
//! - `corpusRoles.promotionHoldoutTaskIds` is empty: this repo's loop
//!   selects and promotes on the SAME frozen bench, so it has no held-out
//!   promotion corpus. That satisfies the contract's disjointness check
//!   vacuously while exposing the substantive gap instead of hiding it.
//! - `resourceEvidence` is zeroed: the evolution loop does not meter
//!   cost/latency/tokens today.
//! - Signing uses this mesh's `PeerIdentity` (ed25519). A verifier must
//!   decide whether to trust that key — being receipt-shaped does not
//!   make a record ruflo-issued.

import { createHash, randomBytes, verify as edVerify } from 'node:crypto';
import {
  CEILINGS,
  promoteAuthorized,
  type EvolutionResult,
  type EvolvableParams,
  type Fitness,
  type PromotionDecision,
} from './mesh-evolve.js';
import type { PeerIdentity } from './transport.js';

/** Exact-match version pins (contract §8; conformance F1). Strings, never
 *  ruflo git SHAs — a SHA pin would couple this repo's release cadence to
 *  ruflo's commit history. */
export const RECEIPT_SCHEMA_VERSION = 'ruflo.flywheel-receipt/v1';
export const RECEIPT_GATE_VERSION = 'ruflo.flywheel-gate/v1';
export const RECEIPT_SIGNING_DOMAIN = 'ruflo/flywheel-receipt/v1';
/** Seed prefix for the paired bootstrap — a domain-separation string in
 *  the statistics section, NOT an Ed25519 signing domain (contract §1). */
export const BOOTSTRAP_SEED_PREFIX = 'ruflo/bootstrap/v1';

export const POLICY_SCHEMA_VERSION = 'autogenous.mesh-evolve-params/v1';
export const CORPUS_VERSION = 'autogenous.mesh-evolve-bench/v1';

/** The three frozen-bench tasks whose separation terms are the paired
 *  evidence. Order is fixed: it is part of the evidence. */
export const BENCH_TASK_IDS = ['diverse-pair-margin', 'stack-margin', 'mixed-trio-margin'] as const;

export interface ReceiptSignature {
  algorithm: 'ed25519';
  domain: typeof RECEIPT_SIGNING_DOMAIN;
  publicKeyPem: string;
  signatureBase64: string;
}

/** A `ruflo.flywheel-receipt/v1` document. `payload` is deliberately the
 *  open contract shape rather than a TS mirror of every field: consumers
 *  MUST validate structurally (verifyExportedReceipt), not by type. */
export interface ExportedReceipt {
  payload: Record<string, unknown>;
  signature: ReceiptSignature;
}

// ── JCS (RFC 8785) within the contract's number domain ──────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** RFC 8785 canonical JSON, restricted to the contract's number domain:
 *  only integers may appear as JSON numbers (fractional values are
 *  decimal strings per ADR-322C), so ECMAScript float formatting never
 *  comes into play. Non-integer or non-finite numbers throw. */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isInteger(value) || Object.is(value, -0)) {
        throw new Error('contract forbids non-integer JSON numbers and -0');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`unsupported JSON type: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcsCanonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(utf16Compare);
  const parts: string[] = [];
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`forbidden key: ${key}`);
    parts.push(`${JSON.stringify(key)}:${jcsCanonicalize(obj[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** JCS sorts keys by UTF-16 code units. */
function utf16Compare(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** ADR-322C content ID over canonical bytes. */
export function contentIdOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(jcsCanonicalize(value), 'utf8').digest('hex')}`;
}

/** Scale-12 decimal encoding with trailing zeros stripped ('' / '-0' → '0'),
 *  per ADR-322C §Update (2026-08-19) section 4. */
export function decimal12(value: number): string {
  if (!Number.isFinite(value)) throw new Error('non-finite value cannot be encoded');
  let rendered = value.toFixed(12);
  if (rendered.includes('.')) rendered = rendered.replace(/0+$/, '').replace(/\.$/, '');
  return rendered === '' || rendered === '-0' ? '0' : rendered;
}

/** UUIDv7: 48-bit ms timestamp, version 7, RFC 9562 variant. */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[5 - i] = Number((ms >> BigInt(8 * i)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── normative bootstrap (ADR-322C §Update 2026-08-19) ───────────────────

export interface BootstrapResult {
  seedHex: string;
  relativeLift: string;
  pairedBootstrapProbability: string;
  pairedBootstrapDeltaCILow95: string;
  significant: boolean;
  accepted: boolean;
}

/** Recompute the default statistical rule from ENCODED inputs — the only
 *  form a verifier ever has (conformance B5/B5a; contract gap G5). */
export function recomputeStatistics(args: {
  heldOutDeltas: readonly string[];
  baselineScore: string;
  candidateScore: string;
  frozenAnchorRegression: string;
  iterations: number;
  corpusHash: string;
  candidateId: string;
  baselineRef: string;
  evaluationRunId: string;
}): BootstrapResult {
  const deltas = args.heldOutDeltas.map(Number);
  const baseline = Number(args.baselineScore);
  const candidate = Number(args.candidateScore);
  const frozenAnchor = Number(args.frozenAnchorRegression);

  const seedInput =
    BOOTSTRAP_SEED_PREFIX + args.corpusHash + args.candidateId + args.baselineRef + args.evaluationRunId;
  const digest = createHash('sha256').update(seedInput, 'utf8').digest();
  const seedHex = digest.toString('hex');
  // PRNG state: first four bytes, big-endian; LCG per the amendment.
  let state = digest.readUInt32BE(0);
  const draw = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  const n = deltas.length;
  const means: number[] = [];
  for (let i = 0; i < args.iterations; i++) {
    if (n === 0) {
      means.push(0);
      continue;
    }
    let total = 0;
    for (let j = 0; j < n; j++) total += deltas[Math.floor(draw() * n)]!;
    means.push(total / n);
  }
  const probability = means.filter((m) => m > 0).length / args.iterations;
  const ciLow = [...means].sort((a, b) => a - b)[Math.floor(0.025 * args.iterations)]!;

  const relativeLift = (candidate - baseline) / Math.max(Math.abs(baseline), 1e-12);
  const significant = probability >= 0.95 && ciLow > 0;
  const accepted = relativeLift >= 0.02 && significant && frozenAnchor <= 0;

  return {
    seedHex,
    relativeLift: decimal12(relativeLift),
    pairedBootstrapProbability: decimal12(probability),
    pairedBootstrapDeltaCILow95: decimal12(ciLow),
    significant,
    accepted,
  };
}

// ── promotion → receipt export ──────────────────────────────────────────

/** Fractional knobs as decimal strings so the policy satisfies the
 *  contract's number rules while remaining opaque to it. */
function encodePolicy(params: EvolvableParams): Record<string, unknown> {
  const weights: Record<string, string> = {
    sameProvider: decimal12(params.weights.sameProvider),
    sameArch: decimal12(params.weights.sameArch),
    sameSize: decimal12(params.weights.sameSize),
    sourceJaccard: decimal12(params.weights.sourceJaccard),
  };
  if (params.weights.sameAccuracyBand !== undefined) {
    weights['sameAccuracyBand'] = decimal12(params.weights.sameAccuracyBand);
  }
  return { weights, quorumThreshold: decimal12(params.quorumThreshold) };
}

/** The three separation terms for one (params, fitness) pair, ENCODED.
 *  t1 + t2 + t3 = separation by construction (see `evaluate`). */
function benchScores(params: EvolvableParams, fit: Fitness): [string, string, string] {
  const t1 = fit.diversePair - params.quorumThreshold;
  const t2 = params.quorumThreshold - fit.familyStack;
  const t3 = fit.separation - t1 - t2;
  return [decimal12(t1), decimal12(t2), decimal12(t3)];
}

export interface ExportOptions {
  identity: PeerIdentity;
  /** Persistent lineage of this evolvable surface (UUIDv7). */
  lineageId: string;
  champion: EvolvableParams;
  championFitness: Fitness;
  candidate: EvolvableParams;
  candidateFitness: Fitness;
  decision: PromotionDecision;
  /** Attestor named for the `authorized`/`reversible` conjuncts, which
   *  are supplied by the caller, not recomputed (contract §5). */
  attestor: string;
  /** Ledger head this evaluation ran against; genesis when absent. */
  expectedLedgerHead?: string;
  evaluationRunId?: string;
  issuedAt?: Date;
  /** Validity window in milliseconds (default 24h). */
  ttlMs?: number;
  iterations?: number;
}

const GENESIS_HEAD = `sha256:${'0'.repeat(64)}`;

/** Export one promotion evaluation as a signed, receipt-shaped record.
 *
 *  The record states what the 322C gate would decide about this
 *  candidate; it never relabels this repo's own margin rule. Re-exporting
 *  the same candidate yields the same `candidateId` with a fresh
 *  `evaluationRunId` and `receiptId` (conformance A5). */
export function exportPromotionReceipt(opts: ExportOptions): ExportedReceipt {
  const issuedAt = opts.issuedAt ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + (opts.ttlMs ?? 24 * 60 * 60 * 1000));
  const evaluationRunId = opts.evaluationRunId ?? uuidV7(issuedAt.getTime());
  const iterations = opts.iterations ?? 10000;

  const candidatePolicy = encodePolicy(opts.candidate);
  const candidateId = contentIdOf(candidatePolicy);
  const baselineRef = contentIdOf(encodePolicy(opts.champion));
  // The constitutional ceilings ARE this loop's safety envelope; their
  // fractional bounds are encoded as decimal strings per the contract's
  // number rules.
  const safetyEnvelopeRef = contentIdOf({
    schema: 'autogenous.ceilings/v1',
    weightMin: decimal12(CEILINGS.weightMin),
    weightMax: decimal12(CEILINGS.weightMax),
    quorumMin: decimal12(CEILINGS.quorumMin),
    quorumMax: decimal12(CEILINGS.quorumMax),
  });

  // The corpus is the frozen bench itself; its descriptor is stable so
  // corpusHash is stable across exports.
  const corpusDescriptor = { schema: CORPUS_VERSION, tasks: [...BENCH_TASK_IDS] };
  const corpusHash = contentIdOf(corpusDescriptor);

  const baseScores = benchScores(opts.champion, opts.championFitness);
  const candScores = benchScores(opts.candidate, opts.candidateFitness);
  const pairedOutcomes = BENCH_TASK_IDS.map((taskId, i) => ({
    taskId,
    baselineScore: baseScores[i]!,
    candidateScore: candScores[i]!,
  }));
  // Deltas from the ENCODED scores (G5: a verifier only has these).
  const heldOutDeltas = BENCH_TASK_IDS.map((_, i) =>
    decimal12(Number(candScores[i]!) - Number(baseScores[i]!)),
  );
  const baselineScore = decimal12(baseScores.reduce((s, v) => s + Number(v), 0) / baseScores.length);
  const candidateScore = decimal12(candScores.reduce((s, v) => s + Number(v), 0) / candScores.length);

  const stats = recomputeStatistics({
    heldOutDeltas,
    baselineScore,
    candidateScore,
    frozenAnchorRegression: '0',
    iterations,
    corpusHash,
    candidateId,
    baselineRef,
    evaluationRunId,
  });

  const gates: Record<string, boolean> = {
    better: opts.decision.better,
    safe: opts.decision.safe,
    authorized: opts.decision.authorized,
    reversible: opts.decision.reversible,
  };
  const gatesAllPass = Object.values(gates).every(Boolean);
  // The CONTRACT's decision rule — honest even when it disagrees with
  // this repo's own promotion margin.
  const decision = stats.accepted && gatesAllPass ? 'accepted' : 'rejected';

  const payload: Record<string, unknown> = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    lineageId: opts.lineageId,
    candidateId,
    evaluationRunId,
    baselineRef,
    expectedLedgerHead: opts.expectedLedgerHead ?? GENESIS_HEAD,
    candidatePolicy,
    gateVersion: RECEIPT_GATE_VERSION,
    policySchemaVersion: POLICY_SCHEMA_VERSION,
    safetyEnvelopeRef,
    requestedProposer: 'local',
    effectiveProposer: 'local',
    corpusVersion: CORPUS_VERSION,
    corpusHash,
    baselineScore,
    candidateScore,
    heldOutDeltas,
    pairedOutcomes,
    statistics: {
      ruleVersion: RECEIPT_GATE_VERSION,
      relativeLift: stats.relativeLift,
      pairedBootstrapProbability: stats.pairedBootstrapProbability,
      pairedBootstrapDeltaCILow95: stats.pairedBootstrapDeltaCILow95,
      frozenAnchorRegression: '0',
      iterations,
      seedHex: stats.seedHex,
      significant: stats.significant,
      accepted: stats.accepted,
    },
    gates,
    resourceEvidence: {
      p95LatencyMicros: 0,
      costMicrosPerTask: 0,
      tokensPerTask: 0,
      failureRate: '0',
      evaluationCostMicros: 0,
      currency: 'USD',
    },
    evidence: {
      corpusRoles: {
        // Selection and promotion share the frozen bench: an honest gap.
        // The bench tasks are selection tasks; there is NO held-out
        // promotion corpus yet (enumerated on ruvnet/autogenous#10).
        selectionTaskIds: [...BENCH_TASK_IDS],
        promotionHoldoutTaskIds: [],
        guardTaskIds: [],
      },
      verification: { replay: 'deterministic-lcg', ruleVersion: RECEIPT_GATE_VERSION },
      canary: { performed: false },
    },
    termVerification: [
      { term: 'better', verification: 'recomputed', evidenceRef: 'statistics' },
      { term: 'safe', verification: 'recomputed', evidenceRef: 'frozen-hard-gates' },
      {
        term: 'authorized',
        verification: 'trusted-assertion',
        evidenceRef: 'constitutional-ceilings',
        attestor: opts.attestor,
      },
      {
        term: 'reversible',
        verification: 'trusted-assertion',
        evidenceRef: 'champion-rollback-target',
        attestor: opts.attestor,
      },
    ],
    decision,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  // receiptId = SHA-256(JCS(payload minus receiptId)), then reinserted.
  payload['receiptId'] = contentIdOf(payload);

  const signedBytes = signingBytes(payload);
  const signatureHex = opts.identity.sign(signedBytes);
  return {
    payload,
    signature: {
      algorithm: 'ed25519',
      domain: RECEIPT_SIGNING_DOMAIN,
      publicKeyPem: derToPem(opts.identity.publicKeyDer),
      signatureBase64: Buffer.from(signatureHex, 'hex').toString('base64'),
    },
  };
}

/** `UTF8(domain) || 0x00 || JCS(payload)` — payload INCLUDING receiptId
 *  (contract §4). */
function signingBytes(payload: Record<string, unknown>): Buffer {
  return Buffer.concat([
    Buffer.from(RECEIPT_SIGNING_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(jcsCanonicalize(payload), 'utf8'),
  ]);
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

// ── strict verification (consumer side of the contract) ─────────────────

const PAYLOAD_REQUIRED = [
  'schemaVersion',
  'receiptId',
  'lineageId',
  'candidateId',
  'evaluationRunId',
  'baselineRef',
  'expectedLedgerHead',
  'candidatePolicy',
  'gateVersion',
  'policySchemaVersion',
  'safetyEnvelopeRef',
  'requestedProposer',
  'effectiveProposer',
  'corpusVersion',
  'corpusHash',
  'baselineScore',
  'candidateScore',
  'heldOutDeltas',
  'statistics',
  'gates',
  'resourceEvidence',
  'evidence',
  'termVerification',
  'decision',
  'issuedAt',
  'expiresAt',
] as const;
const PAYLOAD_OPTIONAL = ['anchorRef', 'proposerSubstitution', 'pairedOutcomes'] as const;

const CONTENT_ID_RE = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const SIGNATURE_B64_RE = /^[A-Za-z0-9+/]{86}==$/;

/** Verify a receipt-shaped document end to end: strict structure (unknown
 *  fields refused — conformance A1, contract gap G3), content IDs,
 *  exact-domain ed25519 signature over the canonical payload, statistical
 *  recomputation byte-for-byte (B5), corpus-role disjointness (B7), and
 *  expiry (B8). Throws with a specific message on the first violation. */
export function verifyExportedReceipt(
  doc: unknown,
  trustedPublicKeyPems: readonly string[],
  now: Date = new Date(),
): { receiptId: string; accepted: boolean } {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('receipt must be an object');
  }
  const top = doc as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== 'payload' && key !== 'signature') throw new Error(`unknown field: ${key}`);
  }
  const payload = top['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('payload must be an object');
  }
  const p = payload as Record<string, unknown>;

  for (const key of Object.keys(p)) {
    if (!(PAYLOAD_REQUIRED as readonly string[]).includes(key) && !(PAYLOAD_OPTIONAL as readonly string[]).includes(key)) {
      throw new Error(`unknown field: ${key}`);
    }
  }
  for (const key of PAYLOAD_REQUIRED) {
    if (!(key in p)) throw new Error(`missing required field: ${key}`);
  }
  if (p['schemaVersion'] !== RECEIPT_SCHEMA_VERSION) throw new Error('unsupported schemaVersion');
  if (p['gateVersion'] !== RECEIPT_GATE_VERSION) throw new Error('unsupported gateVersion');

  for (const field of ['receiptId', 'candidateId', 'baselineRef', 'expectedLedgerHead', 'safetyEnvelopeRef', 'corpusHash']) {
    const v = p[field];
    if (typeof v !== 'string' || !CONTENT_ID_RE.test(v)) throw new Error(`${field} is not a content ID`);
  }
  for (const field of ['issuedAt', 'expiresAt']) {
    const v = p[field];
    if (typeof v !== 'string' || !TIMESTAMP_RE.test(v)) throw new Error(`${field} is not a contract timestamp`);
  }
  for (const field of ['baselineScore', 'candidateScore']) {
    const v = p[field];
    if (typeof v !== 'string' || !DECIMAL_RE.test(v)) throw new Error(`${field} is not a decimal string`);
  }
  const deltas = p['heldOutDeltas'];
  if (!Array.isArray(deltas) || !deltas.every((d) => typeof d === 'string' && DECIMAL_RE.test(d))) {
    throw new Error('heldOutDeltas must be decimal strings');
  }

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isPlainObject(p['candidatePolicy'])) throw new Error('candidatePolicy is not an object');
  if (!isPlainObject(p['statistics'])) throw new Error('statistics is not an object');
  if (!isPlainObject(p['gates']) || Object.keys(p['gates']).length === 0) {
    throw new Error('gates must be a non-empty object');
  }
  if (!Object.values(p['gates']).every((v) => typeof v === 'boolean')) {
    throw new Error('gates values must be booleans');
  }
  if (!isPlainObject(p['evidence']) || !isPlainObject((p['evidence'] as Record<string, unknown>)['corpusRoles'])) {
    throw new Error('evidence.corpusRoles is not an object');
  }
  const statisticsObj = p['statistics'] as Record<string, unknown>;
  for (const field of ['relativeLift', 'pairedBootstrapProbability', 'pairedBootstrapDeltaCILow95', 'frozenAnchorRegression']) {
    const v = statisticsObj[field];
    if (typeof v !== 'string' || !DECIMAL_RE.test(v)) throw new Error(`statistics.${field} is not a decimal string`);
  }

  // Content IDs (§3).
  if (contentIdOf(p['candidatePolicy']) !== p['candidateId']) throw new Error('candidate content ID mismatch');
  const withoutReceiptId: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (k !== 'receiptId') withoutReceiptId[k] = v;
  if (contentIdOf(withoutReceiptId) !== p['receiptId']) throw new Error('receipt content ID mismatch');

  // Signature (§4): exact domain, hardened length bound, trusted signer.
  const signature = top['signature'];
  if (typeof signature !== 'object' || signature === null) throw new Error('signature missing');
  const sig = signature as Record<string, unknown>;
  for (const key of Object.keys(sig)) {
    if (!['algorithm', 'domain', 'publicKeyPem', 'signatureBase64'].includes(key)) {
      throw new Error(`unknown field: ${key}`);
    }
  }
  if (sig['algorithm'] !== 'ed25519') throw new Error('algorithm is not ed25519');
  if (sig['domain'] !== RECEIPT_SIGNING_DOMAIN) throw new Error('domain is not the receipt domain');
  const pem = sig['publicKeyPem'];
  if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new Error('publicKeyPem is not SPKI PEM');
  }
  const sigB64 = sig['signatureBase64'];
  if (typeof sigB64 !== 'string' || !SIGNATURE_B64_RE.test(sigB64)) {
    throw new Error('signatureBase64 outside ^[A-Za-z0-9+/]{86}==$');
  }
  const pemBody = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  if (!trustedPublicKeyPems.some((t) => t.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '') === pemBody)) {
    throw new Error('signer not in trusted set');
  }
  const ok = edVerify(null, signingBytes(p), pem, Buffer.from(sigB64, 'base64'));
  if (!ok) throw new Error('ed25519 signature does not verify');

  // Statistics (§6.1): recomputed, never read.
  const statistics = p['statistics'] as Record<string, unknown>;
  const iterations = statistics['iterations'];
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 100) {
    throw new Error('statistics.iterations below 100');
  }
  if (statistics['ruleVersion'] !== RECEIPT_GATE_VERSION) throw new Error('unsupported statistics.ruleVersion');
  const recomputed = recomputeStatistics({
    heldOutDeltas: deltas as string[],
    baselineScore: p['baselineScore'] as string,
    candidateScore: p['candidateScore'] as string,
    frozenAnchorRegression: statistics['frozenAnchorRegression'] as string,
    iterations,
    corpusHash: p['corpusHash'] as string,
    candidateId: p['candidateId'] as string,
    baselineRef: p['baselineRef'] as string,
    evaluationRunId: p['evaluationRunId'] as string,
  });
  for (const field of ['seedHex', 'relativeLift', 'pairedBootstrapProbability', 'pairedBootstrapDeltaCILow95'] as const) {
    if (recomputed[field] !== statistics[field]) {
      throw new Error(`statistical decision does not recompute: ${field}`);
    }
  }
  for (const field of ['significant', 'accepted'] as const) {
    if (recomputed[field] !== statistics[field]) {
      throw new Error(`statistical decision does not recompute: ${field}`);
    }
  }
  const gates = p['gates'] as Record<string, unknown>;
  const gatesAllPass = Object.values(gates).every((v) => v === true);
  const decision = recomputed.accepted && gatesAllPass ? 'accepted' : 'rejected';
  if (p['decision'] !== decision) throw new Error('statistical decision does not recompute: decision');

  // Corpus-role disjointness (B7) and expiry (B8).
  const roles = (p['evidence'] as Record<string, unknown>)['corpusRoles'] as Record<string, unknown>;
  const selection = roles['selectionTaskIds'] as unknown[];
  const holdout = roles['promotionHoldoutTaskIds'] as unknown[];
  if (Array.isArray(selection) && Array.isArray(holdout)) {
    for (const task of selection) {
      if (holdout.includes(task)) throw new Error('corpus roles are not disjoint');
    }
  }
  const expiresAt = p['expiresAt'] as string;
  if (expiresAt <= now.toISOString()) throw new Error('receipt is expired');

  return { receiptId: p['receiptId'] as string, accepted: recomputed.accepted };
}

// ── integration with the governed loop ──────────────────────────────────

export interface EvolutionExportOptions {
  identity: PeerIdentity;
  lineageId: string;
  /** Attestor for the `authorized`/`reversible` conjuncts. */
  attestor: string;
  /** The params the run started from (defaults are reconstructable by
   *  the caller; required here so baselines are never guessed). */
  start: EvolvableParams;
  /** Deterministic per-generation fitness, i.e. `evaluate`. Injected so
   *  the export never invents fitness the loop did not compute. */
  evaluateFn: (params: EvolvableParams) => Fitness;
  issuedAt?: Date;
}

/** One receipt per promoted generation of an `evolveMesh` run — the
 *  promotion path's records, exported in the contract shape. The
 *  baseline of each promotion is the champion the loop actually held
 *  before it (reconstructed from `history`, which records the champion
 *  AFTER each generation). */
export function exportEvolutionReceipts(
  result: EvolutionResult,
  opts: EvolutionExportOptions,
): ExportedReceipt[] {
  const receipts: ExportedReceipt[] = [];
  let baseline = opts.start;
  for (const record of result.history) {
    if (record.promoted) {
      const candidate = record.champion;
      const baselineFitness = opts.evaluateFn(baseline);
      const candidateFitness = record.fitness;
      // The loop's own four-conjunct predicate, re-run on the recorded
      // pair (ADR-401 Decision 3): the export must agree with what the
      // loop decided, or something is wrong enough to throw.
      const decision = promoteAuthorized(candidateFitness, baselineFitness, {
        authorized: true,
        reversible: true,
      });
      if (!decision.promote) {
        throw new Error(`generation ${record.generation}: recorded promotion does not re-derive`);
      }
      const exportOpts: ExportOptions = {
        identity: opts.identity,
        lineageId: opts.lineageId,
        champion: baseline,
        championFitness: baselineFitness,
        candidate,
        candidateFitness,
        decision,
        attestor: opts.attestor,
      };
      if (opts.issuedAt !== undefined) exportOpts.issuedAt = opts.issuedAt;
      receipts.push(exportPromotionReceipt(exportOpts));
      baseline = candidate;
    }
  }
  return receipts;
}
