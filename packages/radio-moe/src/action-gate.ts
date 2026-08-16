//! Constitutional action release for ADR-397's action-mixture plane.
//!
//! Agent count is deliberately not quorum: authenticated reports that share an
//! operator, model lineage, evidence, or source provenance are one correlated
//! vote. Policy and trust roots are snapshotted at construction so evaluation
//! cannot be weakened by mutating caller-owned configuration.

import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';

const DEFAULT_MAX_SUPPORTS = 16;
const DEFAULT_MAX_PROVENANCE_IDS = 64;
const DEFAULT_MAX_ACTION_BYTES = 64 * 1024;
const DEFAULT_MAX_SUPPORT_BYTES = 256 * 1024;
const DEFAULT_MAX_SUPPORT_TTL_MS = 60_000;
const DEFAULT_CLOCK_SKEW_MS = 5_000;
const CALIBRATION_SCALE = 1_000_000;

export interface GovernedAction {
  capability: string;
  tool: string;
  target: string;
  arguments: unknown;
  jurisdiction: string;
}

export interface UnsignedActionSupport {
  agentId: string;
  /** The admitted human/service authority behind this agent. */
  principalId: string;
  /** A stable model lineage, not a request-local model alias. */
  modelId: string;
  /** Raw-source/provenance identities used to reach this proposal. */
  sourceIds: readonly string[];
  evidenceHashes: readonly string[];
  /** Historical calibration in [0, 1], used only for deterministic tie-breaks. */
  calibration: number;
  /** Risk estimate for this exact action in [0, 1]. */
  risk: number;
  action: GovernedAction;
  issuedAt: number;
  expiresAt: number;
}

export interface ActionSupport extends UnsignedActionSupport {
  /** Ed25519 signature by the admitted key pinned for `agentId`. */
  signature: string;
}

export type AdmissibilityCallback = (
  action: Readonly<GovernedAction>,
  support: readonly Readonly<ActionSupport>[],
) => boolean | Promise<boolean>;

export interface ActionGateOptions {
  minimumQuorum: number;
  riskThreshold: number;
  admissible: AdmissibilityCallback;
  /** Admitted agent id -> DER SPKI Ed25519 public key (hex). */
  trustedSigners: ReadonlyMap<string, string>;
  maxSupports?: number;
  maxProvenanceIds?: number;
  maxActionBytes?: number;
  maxSupportBytes?: number;
  maxSupportTtlMs?: number;
  clockSkewMs?: number;
}

interface FrozenPolicy {
  readonly minimumQuorum: number;
  readonly riskThreshold: number;
  readonly admissible: AdmissibilityCallback;
  readonly maxSupports: number;
  readonly maxProvenanceIds: number;
  readonly maxActionBytes: number;
  readonly maxSupportBytes: number;
  readonly maxSupportTtlMs: number;
  readonly clockSkewMs: number;
}

export type ActionRejection =
  | 'inadmissible'
  | 'insufficient-independent-quorum'
  | 'risk-threshold'
  | 'action-mismatch';

export interface ActionDecision {
  actionId: string;
  execute: boolean;
  independentSupport: readonly ActionSupport[];
  risk: number;
  /** Authenticated proposals for other action identities, ignored rather than vetoing. */
  mismatchedSupport: number;
  rejection?: ActionRejection;
}

/** Sign one canonical support statement. The signer id must be its admitted agent id. */
export function signActionSupport(identity: PeerIdentity, support: UnsignedActionSupport): ActionSupport {
  if (support.agentId !== identity.peerId) throw new TypeError('support agentId must match signer identity');
  assertCanonicalJson(support);
  const unsigned = cloneCanonical(support);
  return { ...unsigned, signature: identity.sign(canonicalBytes(unsigned)) };
}

/** The only fields that constitute action identity, canonically hashed. */
export function actionIdentity(action: GovernedAction, maxBytes = DEFAULT_MAX_ACTION_BYTES): string {
  validateAction(action, maxBytes);
  return createHash('sha256')
    .update(
      canonicalBytes({
        arguments: action.arguments,
        capability: action.capability,
        jurisdiction: action.jurisdiction,
        target: action.target,
        tool: action.tool,
      }),
    )
    .digest('hex');
}

/** True only when neither supporter reuses an authority or correlation source. */
export function supportsAreIndependent(a: ActionSupport, b: ActionSupport): boolean {
  return (
    a.agentId !== b.agentId &&
    a.principalId !== b.principalId &&
    a.modelId !== b.modelId &&
    disjoint(a.sourceIds, b.sourceIds) &&
    disjoint(a.evidenceHashes, b.evidenceHashes)
  );
}

/**
 * Deterministic maximum pairwise-independent subset. The bounded support set
 * makes exhaustive selection safe and avoids input-order-dependent greediness.
 */
export function independentSupportSet(support: readonly ActionSupport[]): ActionSupport[] {
  if (support.length > DEFAULT_MAX_SUPPORTS) throw new RangeError('support set exceeds hard maximum');
  const candidates = [...support].sort((a, b) => codeUnitCompare(a.agentId, b.agentId));
  let best: ActionSupport[] = [];

  const visit = (index: number, chosen: ActionSupport[]): void => {
    if (chosen.length + candidates.length - index < best.length) return;
    if (index === candidates.length) {
      if (better(chosen, best)) best = [...chosen];
      return;
    }
    const candidate = candidates[index];
    if (candidate && chosen.every((other) => supportsAreIndependent(candidate, other))) {
      chosen.push(candidate);
      visit(index + 1, chosen);
      chosen.pop();
    }
    visit(index + 1, chosen);
  };

  visit(0, []);
  return best;
}

export class ActionGate {
  private readonly policy: FrozenPolicy;
  private readonly trustedSigners: Readonly<Record<string, string>>;

  constructor(options: ActionGateOptions) {
    const maxSupports = boundedInteger(options.maxSupports ?? DEFAULT_MAX_SUPPORTS, 2, DEFAULT_MAX_SUPPORTS, 'maxSupports');
    const minimumQuorum = boundedInteger(options.minimumQuorum, 2, maxSupports, 'minimumQuorum');
    const maxProvenanceIds = boundedInteger(options.maxProvenanceIds ?? DEFAULT_MAX_PROVENANCE_IDS, 1, DEFAULT_MAX_PROVENANCE_IDS, 'maxProvenanceIds');
    if (!finiteUnit(options.riskThreshold) || options.riskThreshold === 0) {
      throw new RangeError('riskThreshold must be in (0, 1]');
    }
    const trusted = new Map(options.trustedSigners);
    if (trusted.size === 0 || trusted.size > maxSupports) throw new RangeError('trustedSigners must be non-empty and bounded');
    for (const [agentId, key] of trusted) assertTrustedSigner(agentId, key);
    this.trustedSigners = Object.freeze(Object.fromEntries(trusted));
    this.policy = Object.freeze({
      minimumQuorum,
      riskThreshold: options.riskThreshold,
      admissible: options.admissible,
      maxSupports,
      maxProvenanceIds,
      maxActionBytes: boundedInteger(options.maxActionBytes ?? DEFAULT_MAX_ACTION_BYTES, 1, DEFAULT_MAX_ACTION_BYTES, 'maxActionBytes'),
      maxSupportBytes: boundedInteger(options.maxSupportBytes ?? DEFAULT_MAX_SUPPORT_BYTES, 1, DEFAULT_MAX_SUPPORT_BYTES, 'maxSupportBytes'),
      maxSupportTtlMs: boundedInteger(options.maxSupportTtlMs ?? DEFAULT_MAX_SUPPORT_TTL_MS, 1, DEFAULT_MAX_SUPPORT_TTL_MS, 'maxSupportTtlMs'),
      clockSkewMs: boundedInteger(options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS, 0, DEFAULT_CLOCK_SKEW_MS, 'clockSkewMs'),
    });
  }

  async evaluate(action: GovernedAction, proposedSupport: readonly ActionSupport[], now = Date.now()): Promise<ActionDecision> {
    validateSafeInteger(now, 'now');
    if (proposedSupport.length > this.policy.maxSupports) throw new RangeError('too many action supports');
    const stableAction = deepFreeze(cloneCanonical(action));
    const id = actionIdentity(stableAction, this.policy.maxActionBytes);
    const matching: ActionSupport[] = [];
    let mismatchedSupport = 0;

    for (const proposed of proposedSupport) {
      const support = this.authenticateSupport(proposed, now);
      if (actionIdentity(support.action, this.policy.maxActionBytes) !== id) {
        mismatchedSupport += 1;
        continue;
      }
      matching.push(support);
    }

    const independent = independentSupportSet(matching);
    const risk = matching.length === 0 ? 1 : Math.max(...matching.map((entry) => entry.risk));
    const base = { actionId: id, independentSupport: independent, risk, mismatchedSupport };
    if (matching.length === 0 && mismatchedSupport > 0) {
      return { ...base, execute: false, rejection: 'action-mismatch' };
    }
    if (!(await this.policy.admissible(stableAction, independent))) {
      return { ...base, execute: false, rejection: 'inadmissible' };
    }
    if (independent.length < this.policy.minimumQuorum) {
      return { ...base, execute: false, rejection: 'insufficient-independent-quorum' };
    }
    if (risk >= this.policy.riskThreshold) {
      return { ...base, execute: false, rejection: 'risk-threshold' };
    }
    return { ...base, execute: true };
  }

  private authenticateSupport(proposed: ActionSupport, now: number): ActionSupport {
    assertCanonicalJson(proposed);
    const bytes = canonicalBytes(proposed);
    if (bytes.length > this.policy.maxSupportBytes) throw new RangeError('support exceeds byte bound');
    validateSupport(proposed, this.policy, now);
    const pinnedKey = this.trustedSigners[proposed.agentId];
    if (!pinnedKey) throw new TypeError('support signer is not admitted');
    const unsigned: UnsignedActionSupport = { ...proposed };
    delete (unsigned as Partial<ActionSupport>).signature;
    try {
      const valid = edVerify(
        null,
        canonicalBytes(unsigned),
        { key: Buffer.from(pinnedKey, 'hex'), format: 'der', type: 'spki' },
        Buffer.from(proposed.signature, 'hex'),
      );
      if (!valid) throw new TypeError('support signature is invalid');
    } catch (error) {
      if (error instanceof TypeError && error.message === 'support signature is invalid') throw error;
      throw new TypeError('support signature is invalid');
    }
    return deepFreeze(cloneCanonical(proposed));
  }
}

function validateAction(action: GovernedAction, maxBytes: number): void {
  assertCanonicalJson(action);
  for (const [name, value] of Object.entries({
    capability: action.capability,
    tool: action.tool,
    target: action.target,
    jurisdiction: action.jurisdiction,
  })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`action ${name} must be non-empty`);
  }
  if (canonicalBytes(action).length > maxBytes) throw new RangeError('action exceeds byte bound');
}

function validateSupport(support: ActionSupport, policy: FrozenPolicy, now: number): void {
  for (const field of ['agentId', 'principalId', 'modelId', 'signature'] as const) {
    if (!support[field]) throw new TypeError(`support ${field} must be non-empty`);
  }
  if (!finiteUnit(support.calibration)) throw new RangeError('support calibration must be in [0, 1]');
  if (!finiteUnit(support.risk)) throw new RangeError('support risk must be in [0, 1]');
  validateIdSet(support.sourceIds, policy.maxProvenanceIds, 'sourceIds');
  validateIdSet(support.evidenceHashes, policy.maxProvenanceIds, 'evidenceHashes');
  validateSafeInteger(support.issuedAt, 'support issuedAt');
  validateSafeInteger(support.expiresAt, 'support expiresAt');
  if (support.expiresAt <= support.issuedAt || support.expiresAt - support.issuedAt > policy.maxSupportTtlMs) {
    throw new RangeError('support validity window exceeds bounds');
  }
  if (support.issuedAt > now + policy.clockSkewMs || now >= support.expiresAt) throw new RangeError('support is not currently valid');
  validateAction(support.action, policy.maxActionBytes);
}

function assertTrustedSigner(agentId: string, publicKeyDer: string): void {
  if (!agentId || !publicKeyDer) throw new TypeError('trusted signer id and key must be non-empty');
  const der = Buffer.from(publicKeyDer, 'hex');
  const fingerprint = createHash('sha256').update(der).digest('hex').slice(0, 16);
  if (fingerprint !== agentId) throw new TypeError('trusted signer id does not match public key');
}

function validateIdSet(values: readonly string[], max: number, name: string): void {
  if (!Array.isArray(values) || values.length === 0 || values.length > max) throw new RangeError(`${name} must be non-empty and bounded`);
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${name} entries must be bounded non-empty strings`);
    if (seen.has(value)) throw new TypeError(`${name} entries must be unique`);
    seen.add(value);
  }
}

function finiteUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function disjoint(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return b.every((value) => !left.has(value));
}

function better(candidate: readonly ActionSupport[], incumbent: readonly ActionSupport[]): boolean {
  if (candidate.length !== incumbent.length) return candidate.length > incumbent.length;
  const candidateScore = candidate.reduce((sum, item) => sum + quantizedCalibration(item.calibration), 0);
  const incumbentScore = incumbent.reduce((sum, item) => sum + quantizedCalibration(item.calibration), 0);
  if (candidateScore !== incumbentScore) return candidateScore > incumbentScore;
  return codeUnitCompare(candidate.map((item) => item.agentId).join('\u0000'), incumbent.map((item) => item.agentId).join('\u0000')) < 0;
}

function quantizedCalibration(value: number): number {
  return Math.round(value * CALIBRATION_SCALE);
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}

function validateSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
}

function cloneCanonical<T>(value: T): T {
  assertCanonicalJson(value);
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Restrict signed/hashes values to deterministic JSON without lossy coercions. */
function assertCanonicalJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return;
  }
  if (typeof value !== 'object') throw new TypeError('value is not canonical JSON');
  const object = value as object;
  if (seen.has(object)) throw new TypeError('canonical JSON must be acyclic');
  seen.add(object);
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('canonical JSON must not contain symbol keys');
      if (key === 'length') continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) throw new TypeError('canonical JSON arrays must not have named properties');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('canonical JSON properties must be enumerable data properties');
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError('canonical JSON arrays must not be sparse');
      assertCanonicalJson(value[index], seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON objects must be plain');
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('canonical JSON must not contain symbol keys');
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new TypeError(`forbidden canonical JSON key: ${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('canonical JSON properties must be enumerable data properties');
      assertCanonicalJson(descriptor.value, seen);
    }
  }
  seen.delete(object);
}
