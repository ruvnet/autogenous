//! Deterministic rolling claim/evidence mixture state (ADR-397).
//!
//! This is a claim-level mixture over verified, structured AgentFrames. It does
//! not treat text as logits or claim to perform token-level MoE.

import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalBytes, type AgentFrame, verifyFrame } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';

export type ClaimRelation = 'support' | 'contradict';

/** Normalized inputs to ADR-397's q/r/e-c-l-u gating formula. */
export interface MixtureDimensions {
  quality: number;
  relevance: number;
  evidence: number;
  cost: number;
  latency: number;
  uncertainty: number;
}

/** Semantic metadata deliberately kept separate from the transport frame. */
export interface ContributionInput extends MixtureDimensions {
  /** Stable identity of the claim being supported or contradicted. */
  claimId: string;
  relation: ClaimRelation;
  /** Independent source identities used to retain evidence provenance. */
  sourceIds: string[];
  /** Signature by the frame signer over frameHash + every field above. */
  bindingSignature: string;
}

export type UnsignedContributionInput = Omit<ContributionInput, 'bindingSignature'>;

export interface MixtureCoefficients {
  quality: number;
  relevance: number;
  evidence: number;
  cost: number;
  latency: number;
  uncertainty: number;
}

export interface MixtureConfig {
  requestId: string;
  /** Agent id -> DER SPKI public key (hex). */
  trustedSigners: Readonly<Record<string, string>>;
  coefficients?: Partial<MixtureCoefficients>;
  topK?: number;
  maxAcceptedFrames?: number;
  maxBufferedFramesPerAgent?: number;
  /** Decimal places retained in scores and weights (0..12). */
  precision?: number;
}

export interface MixtureContribution {
  frameHash: string;
  requestId: string;
  agentId: string;
  step: number;
  kind: 'claim' | 'evidence';
  claimId: string;
  relation: ClaimRelation;
  value: unknown;
  dimensions: MixtureDimensions;
  score: number;
  weight: number;
  sourceIds: string[];
  evidenceHashes: string[];
  dependencies: string[];
  capabilityUsed: string;
  bindingSignature: string;
}

export interface ClaimMixture {
  claimId: string;
  supportWeight: number;
  contradictionWeight: number;
  netWeight: number;
  confidence: number;
  contradictory: boolean;
  contributionHashes: string[];
  evidenceHashes: string[];
  sourceIds: string[];
}

export interface Contradiction {
  claimId: string;
  supportingFrames: string[];
  contradictingFrames: string[];
}

export interface MixtureSnapshot {
  requestId: string;
  revision: number;
  stateHash: string;
  /** Complete append-only accepted-frame audit, in canonical fold order. */
  audit: MixtureContribution[];
  /** Currently active Top-K contributions, in gate rank order. */
  contributions: MixtureContribution[];
  claims: ClaimMixture[];
  contradictions: Contradiction[];
  bufferedFrames: number;
  /** Signers removed after producing two different valid frames at one step. */
  equivocatingAgents: string[];
}

export type MixtureUpdate =
  | { status: 'accepted'; acceptedFrameHashes: string[]; snapshot: MixtureSnapshot }
  | { status: 'buffered'; frameHash: string; snapshot: MixtureSnapshot }
  | { status: 'duplicate'; frameHash: string; snapshot: MixtureSnapshot }
  | { status: 'rejected'; reason: string; snapshot: MixtureSnapshot };

interface PendingFrame {
  frame: AgentFrame;
  input: ContributionInput;
  frameHash: string;
}

const DEFAULT_COEFFICIENTS: MixtureCoefficients = {
  quality: 1,
  relevance: 1,
  evidence: 1,
  cost: 1,
  latency: 1,
  uncertainty: 1,
};

const DEFAULT_TOP_K = 6;
const DEFAULT_MAX_ACCEPTED = 10_000;
const DEFAULT_MAX_BUFFERED = 128;
const DEFAULT_PRECISION = 9;
const MAX_COEFFICIENT = 100;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_COLLECTION_ITEMS = 4_096;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_PROVENANCE_ITEMS = 256;
const MAX_IDENTIFIER_BYTES = 1_024;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/i;
const FRAME_FIELDS = [
  'agentId', 'capabilityUsed', 'confidence', 'cost', 'dependencies', 'evidenceHashes',
  'kind', 'requestId', 'signature', 'step', 'uncertainty', 'value',
] as const;
const INPUT_FIELDS = [
  'bindingSignature', 'claimId', 'cost', 'evidence', 'latency', 'quality', 'relation',
  'relevance', 'sourceIds', 'uncertainty',
] as const;

/** Canonical bytes binding unsigned mixture semantics to one exact signed frame. */
export function contributionBindingBytes(
  frameHash: string,
  input: UnsignedContributionInput | ContributionInput,
): Buffer {
  const { bindingSignature: _ignored, ...unsigned } = input as ContributionInput;
  return canonicalBytes({ frameHash, input: unsigned });
}

/** Create the required detached binding with the same identity that signed the frame. */
export function signContributionInput(
  identity: PeerIdentity,
  frame: AgentFrame,
  input: UnsignedContributionInput,
): ContributionInput {
  const frameHash = hashCanonical(frame);
  return {
    ...input,
    bindingSignature: identity.sign(contributionBindingBytes(frameHash, input)),
  };
}

/** Mutable request-scoped aggregate whose public snapshots are immutable copies. */
export class MixtureState {
  readonly #config: Required<Omit<MixtureConfig, 'coefficients'>> & {
    coefficients: MixtureCoefficients;
  };
  readonly #accepted = new Map<string, MixtureContribution>();
  readonly #seen = new Set<string>();
  readonly #pending = new Map<string, Map<number, PendingFrame>>();
  readonly #nextStep = new Map<string, number>();
  readonly #stepHashes = new Map<string, Map<number, string>>();
  readonly #equivocating = new Set<string>();

  constructor(config: MixtureConfig) {
    if (!nonEmpty(config.requestId)) throw new Error('requestId must be non-empty');
    if (Object.keys(config.trustedSigners).length === 0) {
      throw new Error('trustedSigners must not be empty');
    }
    const coefficients = { ...DEFAULT_COEFFICIENTS, ...config.coefficients };
    for (const [name, value] of Object.entries(coefficients)) {
      if (!Number.isFinite(value) || value < 0 || value > MAX_COEFFICIENT) {
        throw new Error(`coefficient ${name} must be within 0..${MAX_COEFFICIENT}`);
      }
    }
    const topK = boundedInteger(config.topK ?? DEFAULT_TOP_K, 'topK', 1, 256);
    const maxAcceptedFrames = boundedInteger(
      config.maxAcceptedFrames ?? DEFAULT_MAX_ACCEPTED,
      'maxAcceptedFrames',
      topK,
      1_000_000,
    );
    this.#config = {
      requestId: config.requestId,
      trustedSigners: { ...config.trustedSigners },
      coefficients,
      topK,
      maxAcceptedFrames,
      maxBufferedFramesPerAgent: boundedInteger(
        config.maxBufferedFramesPerAgent ?? DEFAULT_MAX_BUFFERED,
        'maxBufferedFramesPerAgent',
        0,
        10_000,
      ),
      precision: boundedInteger(config.precision ?? DEFAULT_PRECISION, 'precision', 0, 12),
    };
  }

  consume(frame: AgentFrame, input: ContributionInput): MixtureUpdate {
    // Structural and byte bounds intentionally run before any public-key work.
    const validationError = this.#validateShape(frame, input);
    if (validationError) return { status: 'rejected', reason: validationError, snapshot: this.snapshot() };

    let frameHash: string;
    try {
      frameHash = hashCanonical(frame);
    } catch {
      return { status: 'rejected', reason: 'frame is not canonically serializable', snapshot: this.snapshot() };
    }
    const key = this.#config.trustedSigners[frame.agentId];
    if (!key || !verifyFrame(frame, key)) {
      return { status: 'rejected', reason: 'frame signer is untrusted or signature is invalid', snapshot: this.snapshot() };
    }
    if (!verifyBinding(frameHash, input, key)) {
      return { status: 'rejected', reason: 'contribution binding signature is invalid', snapshot: this.snapshot() };
    }
    const bindingHash = hashCanonical({ frameHash, input });
    if (this.#equivocating.has(frame.agentId)) {
      return { status: 'rejected', reason: 'agent is quarantined for signer equivocation', snapshot: this.snapshot() };
    }

    const agentSteps = this.#stepHashes.get(frame.agentId);
    const priorHash = agentSteps?.get(frame.step);
    if (priorHash === bindingHash) return { status: 'duplicate', frameHash, snapshot: this.snapshot() };
    if (priorHash !== undefined) {
      this.#quarantine(frame.agentId);
      return { status: 'rejected', reason: 'signer equivocation; agent quarantined', snapshot: this.snapshot() };
    }
    // Detach caller-owned objects after verification to avoid buffered-frame TOCTOU.
    const storedFrame = canonicalClone(frame) as AgentFrame;

    const expected = this.#nextStep.get(frame.agentId) ?? 0;
    if (frame.step < expected) {
      return { status: 'rejected', reason: 'stale or conflicting agent step', snapshot: this.snapshot() };
    }
    if (frame.step > expected) {
      const pending = this.#pending.get(frame.agentId) ?? new Map<number, PendingFrame>();
      if (pending.has(frame.step)) {
        return { status: 'rejected', reason: 'conflicting frame at buffered agent step', snapshot: this.snapshot() };
      }
      if (pending.size >= this.#config.maxBufferedFramesPerAgent) {
        return { status: 'rejected', reason: 'agent gap buffer is full', snapshot: this.snapshot() };
      }
      pending.set(frame.step, { frame: storedFrame, input: normalizeInput(input, this.#config.precision), frameHash });
      this.#pending.set(frame.agentId, pending);
      this.#rememberStep(frame.agentId, frame.step, bindingHash);
      this.#seen.add(frameHash);
      return { status: 'buffered', frameHash, snapshot: this.snapshot() };
    }

    const pending = this.#pending.get(frame.agentId);
    const contiguous: PendingFrame[] = [{
      frame: storedFrame,
      input: normalizeInput(input, this.#config.precision),
      frameHash,
    }];
    let next = expected + 1;
    while (pending?.has(next)) {
      contiguous.push(pending.get(next)!);
      next += 1;
    }
    if (this.#accepted.size + contiguous.length > this.#config.maxAcceptedFrames) {
      return { status: 'rejected', reason: 'accepted frame capacity reached', snapshot: this.snapshot() };
    }

    this.#rememberStep(frame.agentId, frame.step, bindingHash);
    for (const item of contiguous) {
      pending?.delete(item.frame.step);
      this.#seen.add(item.frameHash);
      this.#accepted.set(item.frameHash, this.#toContribution(item));
    }
    if (pending?.size === 0) this.#pending.delete(frame.agentId);
    this.#nextStep.set(frame.agentId, next);

    return {
      status: 'accepted',
      acceptedFrameHashes: contiguous.map((item) => item.frameHash),
      snapshot: this.snapshot(),
    };
  }

  snapshot(): MixtureSnapshot {
    const ranked = selectIndependent(
      [...this.#accepted.values()].sort(compareForTopK),
      this.#config.topK,
    );
    const weights = stableSoftmax(ranked.map((item) => item.score), this.#config.precision);
    const contributions = ranked.map((item, index) => cloneContribution(item, weights[index]!));
    const activeWeights = new Map(contributions.map((item) => [item.frameHash, item.weight]));
    const audit = [...this.#accepted.values()]
      .sort(compareCanonicalFold)
      .map((item) => cloneContribution(item, activeWeights.get(item.frameHash) ?? 0));
    const claims = aggregateClaims(contributions, audit, this.#config.precision);
    const contradictions = claims
      .filter((claim) => claim.contradictory)
      .map((claim) => ({
        claimId: claim.claimId,
        supportingFrames: audit
          .filter((item) => item.claimId === claim.claimId && item.relation === 'support')
          .map((item) => item.frameHash).sort(),
        contradictingFrames: audit
          .filter((item) => item.claimId === claim.claimId && item.relation === 'contradict')
          .map((item) => item.frameHash).sort(),
      }));
    const bufferedFrames = [...this.#pending.values()].reduce((sum, frames) => sum + frames.size, 0);
    const equivocatingAgents = [...this.#equivocating].sort();
    const withoutHash = {
      requestId: this.#config.requestId,
      revision: this.#accepted.size + bufferedFrames + equivocatingAgents.length,
      audit,
      contributions,
      claims,
      contradictions,
      bufferedFrames,
      equivocatingAgents,
    };
    return { ...withoutHash, stateHash: hashCanonical(withoutHash) };
  }

  #validateShape(frame: AgentFrame, input: ContributionInput): string | undefined {
    if (!exactPlainObject(frame, FRAME_FIELDS)) return 'frame shape is invalid';
    if (!exactPlainObject(input, INPUT_FIELDS)) return 'contribution input shape is invalid';
    if (frame.requestId !== this.#config.requestId) return 'requestId does not match mixture';
    if (!boundedText(frame.requestId) || !boundedText(frame.agentId)) return 'frame identity fields are invalid';
    if (!HEX_SIGNATURE.test(frame.signature)) return 'frame signature encoding is invalid';
    if (!Number.isSafeInteger(frame.step) || frame.step < 0) return 'step must be a non-negative safe integer';
    if (frame.kind !== 'claim' && frame.kind !== 'evidence') return 'only claim and evidence frames can enter this mixture';
    if (!unit(frame.confidence) || !unit(frame.uncertainty) || !Number.isFinite(frame.cost) || frame.cost < 0) {
      return 'frame confidence, uncertainty, or cost is out of bounds';
    }
    if (!boundedText(input.claimId)) return 'claimId must be non-empty and bounded';
    if (input.relation !== 'support' && input.relation !== 'contradict') return 'relation is invalid';
    if (!boundedStringArray(input.sourceIds)) {
      return 'sourceIds must contain bounded non-empty strings';
    }
    for (const [name, value] of dimensionEntries(input)) {
      if (!unit(value)) return `${name} must be within 0..1`;
    }
    if (!boundedStringArray(frame.dependencies) || !boundedStringArray(frame.evidenceHashes)) {
      return 'frame provenance arrays are invalid';
    }
    if (!boundedText(frame.capabilityUsed)) return 'capabilityUsed must be non-empty and bounded';
    if (!HEX_SIGNATURE.test(input.bindingSignature)) return 'contribution binding signature encoding is invalid';
    const jsonError = strictJsonError(frame.value);
    if (jsonError) return `frame value is not strict bounded JSON: ${jsonError}`;
    try {
      if (canonicalBytes(frame).byteLength > MAX_FRAME_BYTES) return 'frame exceeds byte limit';
      if (contributionBindingBytes(hashCanonical(frame), input).byteLength > MAX_FRAME_BYTES) {
        return 'contribution binding exceeds byte limit';
      }
    } catch {
      return 'frame is not canonically serializable';
    }
    return undefined;
  }

  #rememberStep(agentId: string, step: number, frameHash: string): void {
    const steps = this.#stepHashes.get(agentId) ?? new Map<number, string>();
    steps.set(step, frameHash);
    this.#stepHashes.set(agentId, steps);
  }

  #quarantine(agentId: string): void {
    this.#equivocating.add(agentId);
    for (const [hash, contribution] of this.#accepted) {
      if (contribution.agentId === agentId) this.#accepted.delete(hash);
    }
    this.#pending.delete(agentId);
    this.#nextStep.delete(agentId);
    this.#stepHashes.delete(agentId);
  }

  #toContribution(item: PendingFrame): MixtureContribution {
    const { frame, input, frameHash } = item;
    const c = this.#config.coefficients;
    const score = round(
      c.quality * input.quality
      + c.relevance * input.relevance
      + c.evidence * input.evidence
      - c.cost * input.cost
      - c.latency * input.latency
      - c.uncertainty * input.uncertainty,
      this.#config.precision,
    );
    return {
      frameHash,
      requestId: frame.requestId,
      agentId: frame.agentId,
      step: frame.step,
      kind: frame.kind as 'claim' | 'evidence',
      claimId: input.claimId,
      relation: input.relation,
      value: canonicalClone(frame.value),
      dimensions: pickDimensions(input),
      score,
      weight: 0,
      sourceIds: sortedUnique(input.sourceIds),
      evidenceHashes: sortedUnique(frame.evidenceHashes),
      dependencies: sortedUnique(frame.dependencies),
      capabilityUsed: frame.capabilityUsed,
      bindingSignature: input.bindingSignature,
    };
  }
}

function aggregateClaims(
  contributions: MixtureContribution[],
  audit: MixtureContribution[],
  precision: number,
): ClaimMixture[] {
  const ids = sortedUnique(audit.map((item) => item.claimId));
  return ids.map((claimId) => {
    const items = contributions.filter((item) => item.claimId === claimId);
    const auditedItems = audit.filter((item) => item.claimId === claimId);
    const supportWeight = round(items.filter((item) => item.relation === 'support').reduce((n, item) => n + item.weight, 0), precision);
    const contradictionWeight = round(items.filter((item) => item.relation === 'contradict').reduce((n, item) => n + item.weight, 0), precision);
    const total = supportWeight + contradictionWeight;
    return {
      claimId,
      supportWeight,
      contradictionWeight,
      netWeight: round(supportWeight - contradictionWeight, precision),
      confidence: total === 0 ? 0 : round(supportWeight / total, precision),
      contradictory: auditedItems.some((item) => item.relation === 'support')
        && auditedItems.some((item) => item.relation === 'contradict'),
      contributionHashes: auditedItems.map((item) => item.frameHash).sort(),
      evidenceHashes: sortedUnique(auditedItems.flatMap((item) => item.evidenceHashes)),
      sourceIds: sortedUnique(auditedItems.flatMap((item) => item.sourceIds)),
    };
  });
}

function stableSoftmax(scores: number[], precision: number): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const exponents = scores.map((score) => Math.exp(score - max));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  const scale = 10 ** precision;
  const exactUnits = exponents.map((value) => (value / total) * scale);
  const units = exactUnits.map(Math.floor);
  let remaining = scale - units.reduce((sum, value) => sum + value, 0);
  const remainderOrder = exactUnits
    .map((value, index) => ({ index, remainder: value - units[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) units[remainderOrder[i]!.index]! += 1;
  if (remaining < 0) {
    const removalOrder = [...remainderOrder].reverse();
    for (let i = 0; i < -remaining; i += 1) {
      const target = removalOrder.find((entry) => units[entry.index]! > 0);
      if (!target) throw new Error('softmax quantization underflow');
      units[target.index]! -= 1;
    }
  }
  remaining = scale - units.reduce((sum, value) => sum + value, 0);
  if (remaining !== 0 || units.some((value) => value < 0)) {
    throw new Error('softmax quantization invariant failed');
  }
  // Integer units are non-negative and sum exactly to `scale` by construction.
  return units.map((value) => value / scale);
}

/** Deterministic greedy set: correlated evidence cannot occupy a second slot. */
function selectIndependent(ranked: MixtureContribution[], topK: number): MixtureContribution[] {
  const selected: MixtureContribution[] = [];
  for (const candidate of ranked) {
    const correlated = selected.some((prior) =>
      prior.claimId === candidate.claimId
      && prior.relation === candidate.relation
      && (overlaps(prior.sourceIds, candidate.sourceIds)
        || overlaps(prior.evidenceHashes, candidate.evidenceHashes)),
    );
    if (!correlated) selected.push(candidate);
    if (selected.length === topK) break;
  }
  return selected;
}

function compareForTopK(a: MixtureContribution, b: MixtureContribution): number {
  return b.score - a.score || compareText(a.agentId, b.agentId) || compareText(a.frameHash, b.frameHash);
}

function compareCanonicalFold(a: MixtureContribution, b: MixtureContribution): number {
  return a.step - b.step || compareText(a.agentId, b.agentId) || compareText(a.frameHash, b.frameHash);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeInput(input: ContributionInput, precision: number): ContributionInput {
  return {
    claimId: input.claimId,
    relation: input.relation,
    sourceIds: sortedUnique(input.sourceIds),
    quality: round(input.quality, precision),
    relevance: round(input.relevance, precision),
    evidence: round(input.evidence, precision),
    cost: round(input.cost, precision),
    latency: round(input.latency, precision),
    uncertainty: round(input.uncertainty, precision),
    bindingSignature: input.bindingSignature,
  };
}

function pickDimensions(input: MixtureDimensions): MixtureDimensions {
  return {
    quality: input.quality,
    relevance: input.relevance,
    evidence: input.evidence,
    cost: input.cost,
    latency: input.latency,
    uncertainty: input.uncertainty,
  };
}

function dimensionEntries(value: MixtureDimensions): [string, number][] {
  return [
    ['quality', value.quality], ['relevance', value.relevance], ['evidence', value.evidence],
    ['cost', value.cost], ['latency', value.latency], ['uncertainty', value.uncertainty],
  ];
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

function canonicalClone(value: unknown): unknown {
  return JSON.parse(canonicalBytes(value).toString()) as unknown;
}

function cloneContribution(item: MixtureContribution, weight: number): MixtureContribution {
  return {
    ...item,
    value: canonicalClone(item.value),
    dimensions: { ...item.dimensions },
    weight,
    sourceIds: [...item.sourceIds],
    evidenceHashes: [...item.evidenceHashes],
    dependencies: [...item.dependencies],
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function boundedStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= MAX_PROVENANCE_ITEMS
    && Object.keys(value).length === value.length
    && Object.keys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    })
    && value.every((item) => boundedText(item));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function boundedText(value: unknown): value is string {
  return nonEmpty(value) && Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES;
}

function unit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer within ${min}..${max}`);
  }
  return value;
}

function round(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function verifyBinding(frameHash: string, input: ContributionInput, publicKeyDerHex: string): boolean {
  try {
    return edVerify(
      null,
      contributionBindingBytes(frameHash, input),
      { key: Buffer.from(publicKeyDerHex, 'hex'), format: 'der', type: 'spki' },
      Buffer.from(input.bindingSignature, 'hex'),
    );
  } catch {
    return false;
  }
}

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return b.some((value) => left.has(value));
}

function exactPlainObject(value: unknown, expectedFields: readonly string[]): boolean {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

/** Reject every value whose canonical encoding is ambiguous with another JS value. */
function strictJsonError(root: unknown): string | undefined {
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = (value: unknown, depth: number): string | undefined => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return 'node count exceeds limit';
    if (depth > MAX_JSON_DEPTH) return 'nesting depth exceeds limit';
    if (value === null || typeof value === 'boolean') return undefined;
    if (typeof value === 'string') {
      return Buffer.byteLength(value) <= MAX_STRING_BYTES ? undefined : 'string exceeds byte limit';
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'number must be finite';
      if (Object.is(value, -0)) return 'negative zero is not canonical';
      return undefined;
    }
    if (typeof value !== 'object') return `unsupported ${typeof value} value`;
    if (ancestors.has(value)) return 'cycles are forbidden';
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value) && proto !== Array.prototype) return 'array subclass is not allowed';
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
      return 'only arrays and plain objects are allowed';
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return 'symbol keys are forbidden';
    const stringKeys = keys as string[];
    if (keys.length > MAX_COLLECTION_ITEMS) return 'collection item count exceeds limit';
    if (Array.isArray(value)) {
      if (stringKeys.some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) {
        return 'array has non-index properties';
      }
      if (Object.keys(value).length !== value.length) return 'sparse arrays are forbidden';
    }
    ancestors.add(value);
    for (const key of stringKeys) {
      if (key === 'length' && Array.isArray(value)) continue;
      if (Buffer.byteLength(key) > MAX_IDENTIFIER_BYTES) return 'object key exceeds byte limit';
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return 'forbidden object key';
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return 'accessor properties are forbidden';
      const error = visit(descriptor.value, depth + 1);
      if (error) return error;
    }
    ancestors.delete(value);
    return undefined;
  };

  return visit(root, 0);
}
