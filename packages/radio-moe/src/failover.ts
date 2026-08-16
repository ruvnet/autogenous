//! Deterministic mixture checkpoint replication and fenced mixer takeover.

import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './agent-frame.js';
import { PeerIdentity } from './transport.js';

export const OUTPUT_PROTOCOL_VERSION = 1 as const;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const MAX_CONTRIBUTIONS = 64;
const MAX_TTL_MS = 60_000;
const MAX_ID_LENGTH = 256;
const MAX_OUTPUT_EVENTS = 4_096;
const MAX_TAKEOVERS = 16;

export type OutputKind = 'claim' | 'plan' | 'action' | 'logits';
export type OutputRegime = 'mixture' | 'text-primary';

/** Canonical replay checkpoint containing the reducer state needed to continue. */
export interface MixtureCheckpoint {
  protocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  requestId: string;
  routeEpoch: number;
  window: number;
  acceptedFrameIds: readonly string[];
  agentSteps: Readonly<Record<string, number>>;
  /** Full normalized reducer state, not an opaque caller-provided hash. */
  mixtureState: unknown;
}

export interface OutputEnvelope {
  protocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  routeEpoch: number;
  eventId: string;
  kind: OutputKind;
  regime: OutputRegime;
  requestId: string;
  mixerId: string;
  mixerEpoch: number;
  sequence: number;
  previousHash: string;
  previousStateHash: string;
  stateHash: string;
  payloadHash: string;
  payload: unknown;
  contributionIds: readonly string[];
  checkpoint: MixtureCheckpoint;
  issuedAt: number;
  expiresAt: number;
  publicKeyDer: string;
  signature: string;
}

export type UnsignedOutput = Omit<OutputEnvelope, 'mixerId' | 'stateHash' | 'payloadHash' | 'publicKeyDer' | 'signature'>;

export interface TakeoverGrant {
  protocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  routeEpoch: number;
  regime: OutputRegime;
  grantId: string;
  requestId: string;
  fromMixerId: string;
  toMixerId: string;
  toMixerPublicKeyDer: string;
  mixerEpoch: number;
  lastSequence: number;
  lastEnvelopeHash: string;
  lastStateHash: string;
  issuedAt: number;
  expiresAt: number;
  authorityId: string;
  authorityPublicKeyDer: string;
  signature: string;
}

export type UnsignedTakeoverGrant = Omit<TakeoverGrant, 'authorityId' | 'authorityPublicKeyDer' | 'signature'>;

export class OutputProtocolError extends Error {
  constructor(readonly code: 'invalid-signature' | 'replay' | 'sequence-gap' | 'split-brain' | 'invalid-chain' | 'expired' | 'invalid-takeover' | 'invalid-payload' | 'bounds', message: string) {
    super(message);
    this.name = 'OutputProtocolError';
  }
}

export function initialStateHash(requestId: string, routeEpoch = 0, regime: OutputRegime = 'mixture'): string {
  validateId(requestId, 'requestId');
  validateNonNegativeInteger(routeEpoch, 'routeEpoch');
  validateRegime(regime);
  return digest({ protocolVersion: OUTPUT_PROTOCOL_VERSION, requestId, routeEpoch, regime, state: 'initial' });
}

export function outputEnvelopeHash(envelope: OutputEnvelope): string {
  assertCanonicalJson(envelope);
  return digest(envelope);
}

export function signOutputEnvelope(identity: PeerIdentity, output: UnsignedOutput): OutputEnvelope {
  validateUnsignedOutput(output);
  const payloadHash = digest(output.payload);
  const stableCheckpoint = cloneCanonical(output.checkpoint);
  const stateHash = digest(stableCheckpoint);
  const unsigned: OutputEnvelope = {
    ...cloneCanonical(output),
    checkpoint: stableCheckpoint,
    mixerId: identity.peerId,
    stateHash,
    payloadHash,
    publicKeyDer: identity.publicKeyDer.toString('hex'),
    signature: '',
  };
  return { ...unsigned, signature: identity.sign(signingBytes(unsigned)) };
}

export function createTakeoverGrant(authority: PeerIdentity, grant: UnsignedTakeoverGrant): TakeoverGrant {
  validateGrantShape(grant);
  const publicKeyDer = authority.publicKeyDer.toString('hex');
  const unsigned: TakeoverGrant = {
    ...cloneCanonical(grant),
    authorityId: authority.peerId,
    authorityPublicKeyDer: publicKeyDer,
    signature: '',
  };
  return { ...unsigned, signature: authority.sign(signingBytes(unsigned)) };
}

export interface ShadowOptions {
  routeEpoch?: number;
  mixerEpoch?: number;
  regime?: OutputRegime;
}

/** A shadow stores an authenticated output chain plus the full replay checkpoint. */
export class DeterministicShadow {
  private nextSequence = 0;
  private lastEnvelopeHash = '';
  private lastStateHash: string;
  private lastCheckpoint: MixtureCheckpoint | undefined;
  private activeMixerId: string;
  private activeMixerKey: string;
  private activeEpoch: number;
  private readonly routeEpoch: number;
  private readonly regime: OutputRegime;
  private readonly usedGrantIds = new Set<string>();
  private readonly usedEventIds = new Set<string>();

  constructor(
    readonly requestId: string,
    mixerId: string,
    mixerPublicKeyDer: string,
    options: ShadowOptions = {},
  ) {
    validateId(requestId, 'requestId');
    this.routeEpoch = options.routeEpoch ?? 0;
    this.activeEpoch = options.mixerEpoch ?? 0;
    this.regime = options.regime ?? 'mixture';
    validateNonNegativeInteger(this.routeEpoch, 'routeEpoch');
    validateNonNegativeInteger(this.activeEpoch, 'mixerEpoch');
    validateRegime(this.regime);
    assertFingerprint(mixerId, mixerPublicKeyDer);
    this.activeMixerId = mixerId;
    this.activeMixerKey = mixerPublicKeyDer;
    this.lastStateHash = initialStateHash(requestId, this.routeEpoch, this.regime);
  }

  get cursor(): Readonly<{
    mixerId: string;
    mixerEpoch: number;
    routeEpoch: number;
    regime: OutputRegime;
    nextSequence: number;
    lastEnvelopeHash: string;
    lastStateHash: string;
    checkpoint?: MixtureCheckpoint;
  }> {
    return {
      mixerId: this.activeMixerId,
      mixerEpoch: this.activeEpoch,
      routeEpoch: this.routeEpoch,
      regime: this.regime,
      nextSequence: this.nextSequence,
      lastEnvelopeHash: this.lastEnvelopeHash,
      lastStateHash: this.lastStateHash,
      ...(this.lastCheckpoint ? { checkpoint: cloneCanonical(this.lastCheckpoint) } : {}),
    };
  }

  replicate(envelope: OutputEnvelope, now = Date.now()): void {
    assertCanonicalJson(envelope);
    validateSafeInteger(now, 'now');
    validateEnvelopeShape(envelope);
    if (envelope.protocolVersion !== OUTPUT_PROTOCOL_VERSION || envelope.requestId !== this.requestId || envelope.routeEpoch !== this.routeEpoch || envelope.regime !== this.regime) {
      fail('split-brain', 'output domain does not match shadow');
    }
    if (envelope.mixerEpoch !== this.activeEpoch || envelope.mixerId !== this.activeMixerId) {
      fail('split-brain', 'output is from a stale or competing mixer');
    }
    if (envelope.issuedAt > now || now >= envelope.expiresAt) fail('expired', 'output is not currently valid');
    if (envelope.publicKeyDer !== this.activeMixerKey || !validSignature(envelope)) fail('invalid-signature', 'output signature is invalid');
    if (this.usedEventIds.has(envelope.eventId)) fail('replay', 'output event was already committed');
    if (envelope.sequence < this.nextSequence) fail('replay', 'output sequence was already committed');
    if (envelope.sequence > this.nextSequence) fail('sequence-gap', 'output sequence has a gap');
    if (envelope.previousHash !== this.lastEnvelopeHash || envelope.previousStateHash !== this.lastStateHash) {
      fail('invalid-chain', 'output does not extend the committed shadow cursor');
    }
    if (envelope.payloadHash !== digest(envelope.payload)) fail('invalid-chain', 'payload hash does not match');
    validateCheckpoint(envelope.checkpoint, this.requestId, this.routeEpoch);
    const expectedState = digest(envelope.checkpoint);
    if (envelope.stateHash !== expectedState) fail('invalid-chain', 'replicated checkpoint hash does not match');
    for (const contribution of envelope.contributionIds) {
      if (!envelope.checkpoint.acceptedFrameIds.includes(contribution)) fail('invalid-chain', 'output contribution is absent from checkpoint');
    }

    this.lastEnvelopeHash = outputEnvelopeHash(envelope);
    this.lastStateHash = envelope.stateHash;
    this.lastCheckpoint = deepFreeze(cloneCanonical(envelope.checkpoint));
    this.usedEventIds.add(envelope.eventId);
    this.nextSequence += 1;
  }

  /** Activate a shadow only with a fresh authority-signed fencing epoch and exact cursor. */
  takeover(grant: TakeoverGrant, pinnedAuthorityPublicKeyDer: string, now = Date.now()): void {
    assertCanonicalJson(grant);
    validateSafeInteger(now, 'now');
    validateGrantShape(grant);
    if (grant.issuedAt > now || now >= grant.expiresAt) fail('expired', 'takeover grant is not currently valid');
    if (this.regime === 'text-primary' && this.nextSequence > 0) {
      fail('invalid-takeover', 'text-primary cannot fail over after visible output');
    }
    if (grant.protocolVersion !== OUTPUT_PROTOCOL_VERSION || grant.routeEpoch !== this.routeEpoch || grant.regime !== this.regime) {
      fail('split-brain', 'takeover grant domain does not match shadow');
    }
    if (grant.authorityPublicKeyDer !== pinnedAuthorityPublicKeyDer) fail('invalid-takeover', 'takeover authority is not pinned');
    assertFingerprint(grant.authorityId, grant.authorityPublicKeyDer);
    assertFingerprint(grant.toMixerId, grant.toMixerPublicKeyDer);
    if (grant.toMixerId === grant.fromMixerId) fail('invalid-takeover', 'takeover must change mixer identity');
    if (!validSignature(grant)) fail('invalid-signature', 'takeover grant signature is invalid');
    if (this.usedGrantIds.has(grant.grantId)) fail('replay', 'takeover grant was already used');
    if (this.usedGrantIds.size >= MAX_TAKEOVERS) fail('bounds', 'takeover history exceeds bound');
    if (grant.requestId !== this.requestId || grant.fromMixerId !== this.activeMixerId) fail('invalid-takeover', 'takeover grant targets different active state');
    if (grant.mixerEpoch !== this.activeEpoch + 1) fail('split-brain', 'takeover fencing epoch is not next');
    if (
      grant.lastSequence !== this.nextSequence - 1 ||
      grant.lastEnvelopeHash !== this.lastEnvelopeHash ||
      grant.lastStateHash !== this.lastStateHash
    ) {
      fail('sequence-gap', 'shadow is not exactly replicated through the takeover checkpoint');
    }

    this.usedGrantIds.add(grant.grantId);
    this.activeMixerId = grant.toMixerId;
    this.activeMixerKey = grant.toMixerPublicKeyDer;
    this.activeEpoch = grant.mixerEpoch;
  }
}

function validateUnsignedOutput(output: UnsignedOutput): void {
  assertCanonicalJson(output);
  if (output.protocolVersion !== OUTPUT_PROTOCOL_VERSION) throw new RangeError('unsupported output protocolVersion');
  validateId(output.eventId, 'eventId');
  validateId(output.requestId, 'requestId');
  validateKind(output.kind);
  validateRegime(output.regime);
  validateNonNegativeInteger(output.routeEpoch, 'routeEpoch');
  validateNonNegativeInteger(output.mixerEpoch, 'mixerEpoch');
  validateNonNegativeInteger(output.sequence, 'sequence');
  if (output.mixerEpoch > MAX_TAKEOVERS) throw new RangeError('mixerEpoch exceeds takeover bound');
  if (output.sequence >= MAX_OUTPUT_EVENTS) throw new RangeError('sequence exceeds output bound');
  if (output.sequence === 0) {
    if (output.previousHash !== '') throw new TypeError('genesis previousHash must be empty');
  } else {
    validateHash(output.previousHash, 'previousHash');
  }
  validateHash(output.previousStateHash, 'previousStateHash');
  validateWindow(output.issuedAt, output.expiresAt);
  validateBoundedJson(output.payload, MAX_PAYLOAD_BYTES, 'payload');
  validateIdSet(output.contributionIds, MAX_CONTRIBUTIONS, 'contributionIds', true);
  validateCheckpoint(output.checkpoint, output.requestId, output.routeEpoch);
}

function validateEnvelopeShape(envelope: OutputEnvelope): void {
  validateUnsignedOutput(envelope);
  validateId(envelope.mixerId, 'mixerId');
  validateId(envelope.signature, 'signature');
  validateId(envelope.publicKeyDer, 'publicKeyDer');
  validateHash(envelope.payloadHash, 'payloadHash');
  validateHash(envelope.stateHash, 'stateHash');
}

function validateCheckpoint(checkpoint: MixtureCheckpoint, requestId: string, routeEpoch: number): void {
  validateBoundedJson(checkpoint, MAX_CHECKPOINT_BYTES, 'checkpoint');
  if (checkpoint.protocolVersion !== OUTPUT_PROTOCOL_VERSION || checkpoint.requestId !== requestId || checkpoint.routeEpoch !== routeEpoch) {
    fail('invalid-payload', 'checkpoint domain does not match output');
  }
  validateNonNegativeInteger(checkpoint.window, 'checkpoint window');
  validateIdSet(checkpoint.acceptedFrameIds, MAX_CONTRIBUTIONS, 'acceptedFrameIds', true);
  const agents = Object.entries(checkpoint.agentSteps);
  if (agents.length > MAX_CONTRIBUTIONS) fail('bounds', 'checkpoint agentSteps exceeds bound');
  for (const [agentId, step] of agents) {
    validateId(agentId, 'checkpoint agentId');
    validateNonNegativeInteger(step, 'checkpoint agent step');
  }
  assertCanonicalJson(checkpoint.mixtureState);
}

function validateGrantShape(grant: UnsignedTakeoverGrant | TakeoverGrant): void {
  assertCanonicalJson(grant);
  if (grant.protocolVersion !== OUTPUT_PROTOCOL_VERSION) throw new RangeError('unsupported grant protocolVersion');
  validateNonNegativeInteger(grant.routeEpoch, 'routeEpoch');
  validateRegime(grant.regime);
  for (const [name, value] of Object.entries({
    grantId: grant.grantId,
    requestId: grant.requestId,
    fromMixerId: grant.fromMixerId,
    toMixerId: grant.toMixerId,
    toMixerPublicKeyDer: grant.toMixerPublicKeyDer,
  })) validateId(value, name);
  validateNonNegativeInteger(grant.mixerEpoch, 'mixerEpoch');
  if (grant.mixerEpoch > MAX_TAKEOVERS) throw new RangeError('mixerEpoch exceeds takeover bound');
  if (!Number.isSafeInteger(grant.lastSequence) || grant.lastSequence < -1) throw new RangeError('lastSequence must be a safe integer >= -1');
  if (grant.lastSequence >= 0) {
    validateHash(grant.lastEnvelopeHash, 'lastEnvelopeHash');
    validateHash(grant.lastStateHash, 'lastStateHash');
  }
  validateWindow(grant.issuedAt, grant.expiresAt);
}

function signingBytes<T extends { signature: string }>(value: T): Buffer {
  assertCanonicalJson(value);
  return canonicalBytes({ ...value, signature: '' });
}

function validSignature<T extends { publicKeyDer?: string; authorityPublicKeyDer?: string; signature: string }>(value: T): boolean {
  try {
    const publicKeyDer = value.publicKeyDer ?? value.authorityPublicKeyDer;
    if (!publicKeyDer) return false;
    return edVerify(
      null,
      signingBytes(value),
      { key: Buffer.from(publicKeyDer, 'hex'), format: 'der', type: 'spki' },
      Buffer.from(value.signature, 'hex'),
    );
  } catch {
    return false;
  }
}

function digest(value: unknown): string {
  assertCanonicalJson(value);
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

function assertFingerprint(id: string, publicKeyDer: string): void {
  validateId(id, 'signer id');
  validateId(publicKeyDer, 'public key');
  const fingerprint = createHash('sha256').update(Buffer.from(publicKeyDer, 'hex')).digest('hex').slice(0, 16);
  if (fingerprint !== id) fail('invalid-signature', 'signer identity does not match public key');
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function validateSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
}

function validateWindow(issuedAt: number, expiresAt: number): void {
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) {
    throw new RangeError('issuedAt/expiresAt must define a bounded validity window');
  }
}

function validateId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) throw new TypeError(`${name} must be a bounded non-empty string`);
}

function validateHash(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name} must be a SHA-256 hex digest`);
}

function validateIdSet(values: readonly string[], max: number, name: string, allowEmpty: boolean): void {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.length > max) fail('bounds', `${name} exceeds bounds`);
  const seen = new Set<string>();
  for (const value of values) {
    validateId(value, name);
    if (seen.has(value)) fail('invalid-payload', `${name} contains duplicates`);
    seen.add(value);
  }
}

function validateBoundedJson(value: unknown, maxBytes: number, name: string): void {
  assertCanonicalJson(value);
  if (canonicalBytes(value).length > maxBytes) fail('bounds', `${name} exceeds byte bound`);
}

function validateKind(kind: string): void {
  if (!['claim', 'plan', 'action', 'logits'].includes(kind)) throw new TypeError('invalid output kind');
}

function validateRegime(regime: string): void {
  if (regime !== 'mixture' && regime !== 'text-primary') throw new TypeError('invalid output regime');
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

function fail(code: OutputProtocolError['code'], message: string): never {
  throw new OutputProtocolError(code, message);
}
