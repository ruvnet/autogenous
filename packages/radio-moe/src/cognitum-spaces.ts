//! Cognitum Spaces adapter — connect the mesh to Cognitum Spaces
//! (ADR-402's world-model layer).
//!
//! ADR-402 specified Cognitum Spaces as the external spatial world-model the mesh
//! plugs into. The legacy `GET /v1/spaces` route is deployed behind the
//! Cognitum API gateway; the same adapter supports the accepted versioned
//! `GET /v1/spatial/{kind}` family when enabled. It reads spatial twin state
//! over that REST surface and maps a Cognitum Spaces **Envelope** to a
//! radio-moe **Observation**, so real spatial state flows through `admitObservation`
//! (the same fail-closed admission — no fact without confidence/privacy/expiry).
//!
//! Auth is supplied by the caller: a compatibility `cog_` API key (`X-API-Key`)
//! or a Cognitum OAuth access token issued to the `ruview` public PKCE client
//! with audience/client `ruview` and scope `spaces:read`. A generic Firebase ID
//! token or `cognitum-cli` session token is not a Spaces credential. Keys are
//! read from the environment AT CALL TIME — never hardcoded, never logged.
//! `hasCredentials()` lets a caller skip cleanly when no credential is configured.

import type { Observation, PrivacyClass } from './observation.js';

/** Returns the auth headers for a Cognitum request (may be empty if unconfigured). */
export type CognitumAuth = () => Record<string, string>;

/** cog_ API-key auth (X-API-Key). Key is read at call time. */
export function apiKeyAuth(getKey: () => string | undefined): CognitumAuth {
  return () => {
    const k = getKey();
    return typeof k === 'string' && k.startsWith('cog_') && k.length > 4 && k.length <= 512
      && !/[\s\u0000-\u001f\u007f]/u.test(k) ? { 'x-api-key': k } : {};
  };
}

/** Bearer auth; callers must supply a RuView OAuth `spaces:read` access token. */
export function bearerAuth(getToken: () => string | undefined): CognitumAuth {
  return () => {
    const t = getToken();
    return typeof t === 'string' && t.length > 0 && t.length <= 8192
      && !/[\s\u0000-\u001f\u007f]/u.test(t) ? { authorization: `Bearer ${t}` } : {};
  };
}

/** Convenience: read a `cog_` key from `COGNITUM_SPACES_API` by default. */
export function envApiKeyAuth(envVar = 'COGNITUM_SPACES_API'): CognitumAuth {
  return apiKeyAuth(() => process.env[envVar]);
}

export type CognitumFetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> } } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface CognitumSpacesConfig {
  /** Default: the Cognitum API gateway. Direct service origins are not public. */
  baseUrl?: string;
  auth: CognitumAuth;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: CognitumFetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** The Cognitum Spaces gateway origin; the legacy route is verified live. */
const DEFAULT_BASE_URL = 'https://api.cognitum.one';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SPACES = 100;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 10_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_OBJECT_KEYS = 128;
const MAX_STRING_BYTES = 4_096;
const REQUIRED_EXCLUSIONS = [
  'raw_csi', 'cir', 'rf_tensors', 'recordings', 'pose_frames',
  'vital_waveforms', 'identity_observations',
] as const;

/** A spatial twin as returned by `GET /v1/spaces` (fields typed loosely — the
 *  service owns the schema; we map the stable ones). */
export interface CognitumSpaceTwin {
  id: string;
  tenantId: string;
  workspaceId?: string | null;
  siteId: string;
  name: string;
  connection?: 'connected' | 'degraded' | 'offline' | 'unknown';
  status?: 'live' | 'delayed' | 'stale' | 'unavailable';
  observedAt?: string | null;
  expiresAt?: string | null;
  privacy?: 'P2' | 'P3';
  state: { confidence: number | null; occupancy: number | null; classification: 'P2'; [k: string]: unknown };
  provenance: Record<string, unknown>;
  [k: string]: unknown;
}

/** Versioned spatial collections from Cognitum API ADR-101. */
export const SPATIAL_KINDS = [
  'sites', 'buildings', 'floors', 'spaces', 'zones', 'entities', 'events', 'alerts',
] as const;
export type SpatialKind = typeof SPATIAL_KINDS[number];

/** One strictly validated P2/P3 resource from `/v1/spatial/{kind}`. */
export interface CognitumSpatialResource {
  id: string;
  tenantId: string;
  workspaceId: string;
  kind: SpatialKind;
  schemaVersion: '1.0';
  privacy: 'P2' | 'P3';
  messageId: string;
  eventSequence: number;
  version: number;
  siteId?: string | null;
  buildingId?: string | null;
  floorId?: string | null;
  spaceId?: string | null;
  zoneId?: string | null;
  name?: string | null;
  entityType?: 'sensor' | 'person' | 'object' | 'track' | null;
  identityMode?: 'anonymous' | null;
  eventType?: string | null;
  alertType?: string | null;
  severity?: 'info' | 'warning' | 'critical' | null;
  status?: 'open' | 'acknowledged' | 'resolved' | null;
  observedAt: string;
  expiresAt?: string | null;
  retentionExpiresAt?: string | null;
  confidence?: number | null;
  attributes: Record<string, unknown>;
  provenance: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SpatialPageRequest {
  limit?: number;
  cursor?: string;
  /** Required for API-key compatibility; OAuth derives workspace from the token. */
  workspaceId?: string;
}

export interface SpatialListResult {
  object: 'list';
  kind: SpatialKind;
  schemaVersion: '1.0';
  data: CognitumSpatialResource[];
  nextCursor: string | null;
  boundary: SpacesBoundary;
}

/** A Cognitum Spaces MQTT-fabric Envelope (asyncapi/cognitum-spaces.yaml). */
export interface CognitumSpacesEnvelope {
  schema: string;
  messageId: string;
  sequence: number;
  tenantId: string;
  siteId: string;
  deviceId: string;
  observedAt: string;
  expiresAt: string;
  privacy: 'P2' | 'P3';
  provenance: string;
  confidence?: number;
  modelVersion?: string;
  payload: unknown;
}

export class CognitumSpacesClient {
  private readonly baseUrl: string;
  constructor(private readonly cfg: CognitumSpacesConfig) {
    const url = new URL(cfg.baseUrl ?? DEFAULT_BASE_URL);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('cognitum spaces: HTTPS required');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('cognitum spaces: invalid base URL');
    }
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('cognitum spaces: invalid timeout');
    }
    const maxResponseBytes = cfg.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_CONFIGURED_RESPONSE_BYTES) {
      throw new Error('cognitum spaces: invalid response limit');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  /** True when auth headers are present (a key/token is configured). */
  hasCredentials(): boolean {
    try { return Object.keys(this.authHeaders()).length > 0; } catch { return false; }
  }

  private authHeaders(): Record<string, string> {
    const supplied = this.cfg.auth();
    const apiKey = supplied['x-api-key'];
    const bearer = supplied.authorization;
    if (apiKey !== undefined && bearer !== undefined) throw new Error('cognitum spaces: ambiguous credentials');
    if (apiKey !== undefined) {
      if (!apiKey.startsWith('cog_') || /[\r\n]/.test(apiKey)) throw new Error('cognitum spaces: invalid API key');
      return { 'x-api-key': apiKey };
    }
    if (bearer !== undefined) {
      if (!/^Bearer [^\s]+$/.test(bearer)) throw new Error('cognitum spaces: invalid bearer token');
      return { authorization: bearer };
    }
    return {};
  }

  private async getJson(path: string): Promise<unknown> {
    const fetchImpl = this.cfg.fetchImpl ?? (globalThis.fetch as unknown as CognitumFetchLike);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', ...this.authHeaders() },
        signal: controller.signal,
        redirect: 'error',
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 256).replace(/[\r\n\0]/g, ' ');
      throw new Error(`cognitum spaces: HTTP ${res.status} ${detail}`.trim());
    }
    const contentType = res.headers?.get('content-type');
    if (contentType !== undefined && contentType !== null && !/(?:application\/json|\+json)(?:\s*;|$)/i.test(contentType)) {
      throw new Error('cognitum spaces: unexpected content type');
    }
    const raw = await readBoundedBody(res, this.cfg.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    try { return JSON.parse(raw); } catch { throw new Error('cognitum spaces: malformed JSON'); }
  }

  /** GET /v1/spaces — the caller's authorized spatial twins. Returns just the
   *  twin list; use {@link listSpacesResult} for the privacy boundary too. */
  async listSpaces(): Promise<CognitumSpaceTwin[]> {
    return (await this.listSpacesResult()).data;
  }

  /** GET /v1/spaces — the full Stripe-style list result, INCLUDING the service's
   *  `boundary` (what raw sensing it deliberately excludes from the cloud — the
   *  ADR-402 "raw sensing stays local" enforcement, verifiable at the edge). */
  async listSpacesResult(): Promise<SpacesListResult> {
    return validateSpacesResult(await this.getJson('/v1/spaces'));
  }

  /** Page one exact versioned hierarchy/event/alert collection. Read-only. */
  async listSpatial(kind: SpatialKind, page: SpatialPageRequest = {}): Promise<SpatialListResult> {
    if (!SPATIAL_KINDS.includes(kind)) throw new Error('cognitum spaces: invalid spatial kind');
    const limit = page.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('cognitum spaces: invalid page limit');
    }
    if (page.cursor !== undefined
      && (!page.cursor || page.cursor.length > 512 || /[\u0000-\u001f\u007f]/u.test(page.cursor))) {
      throw new Error('cognitum spaces: invalid page cursor');
    }
    if (page.workspaceId !== undefined && !UUID_RE.test(page.workspaceId)) {
      throw new Error('cognitum spaces: invalid workspace id');
    }
    const auth = this.authHeaders();
    if (auth['x-api-key'] !== undefined && page.workspaceId === undefined) {
      throw new Error('cognitum spaces: API-key spatial reads require workspace id');
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (page.cursor) query.set('cursor', page.cursor);
    if (page.workspaceId) query.set('workspaceId', page.workspaceId);
    return validateSpatialResult(
      await this.getJson(`/v1/spatial/${kind}?${query.toString()}`),
      kind,
    );
  }
}

/** The cloud/edge privacy boundary the Spaces service reports. */
export interface SpacesBoundary {
  authoritativeState?: string;
  cloudRole?: string;
  /** Raw sensing kinds deliberately NOT bridged to the cloud (stay at the edge). */
  excluded?: string[];
}

export interface SpacesListResult {
  data: CognitumSpaceTwin[];
  boundary: SpacesBoundary;
}

async function readBoundedBody(
  response: Awaited<ReturnType<CognitumFetchLike>>,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers?.get('content-length');
  if (declared !== undefined && declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new Error('cognitum spaces: response too large');
    }
  }
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel?.().catch(() => undefined);
        throw new Error('cognitum spaces: response too large');
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(joined);
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('cognitum spaces: response too large');
  return raw;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_FIELDS = new Set([
  'rawcsi', 'csi', 'channelstateinformation', 'cir', 'rawcir', 'channelimpulseresponse',
  'rftensor', 'rftensors', 'packetcapture', 'packetcaptures', 'pcap', 'recording', 'recordings',
  'audiorecording', 'videorecording', 'poseframe', 'poseframes', 'skeleton',
  'keypoints', 'vitalwaveform', 'vitalwaveforms', 'heartratewaveform',
  'identityobservation', 'identityobservations', 'biometric', 'biometrics', 'face',
  'faces', 'faceembedding',
]);

function assertBoundedSemantic(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('cognitum spaces: response structure exceeds bound');
    if (typeof current === 'string') {
      if (new TextEncoder().encode(current).byteLength > MAX_STRING_BYTES) throw new Error('cognitum spaces: response string exceeds bound');
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_ITEMS) throw new Error('cognitum spaces: response array exceeds bound');
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (!record(current)) return;
    const entries = Object.entries(current);
    if (entries.length > MAX_OBJECT_KEYS) throw new Error('cognitum spaces: response object exceeds bound');
    for (const [key, child] of entries) {
      if (new TextEncoder().encode(key).byteLength > MAX_STRING_BYTES) throw new Error('cognitum spaces: response key exceeds bound');
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (FORBIDDEN_FIELDS.has(normalized)) throw new Error('cognitum spaces: forbidden raw field');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function forbiddenRawField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenRawField);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return FORBIDDEN_FIELDS.has(normalized)
      || forbiddenRawField(child);
  });
}

export function validateSpacesResult(value: unknown): SpacesListResult {
  assertBoundedSemantic(value);
  if (!record(value) || value.object !== 'list' || !Array.isArray(value.data) || value.data.length > MAX_SPACES) {
    throw new Error('cognitum spaces: invalid list envelope');
  }
  const boundary = value.boundary;
  if (!record(boundary) || boundary.authoritativeState !== 'HomeCore Edge'
    || !Array.isArray(boundary.excluded)
    || !boundary.excluded.every((item) => typeof item === 'string')
    || REQUIRED_EXCLUSIONS.some((required) => !(boundary.excluded as string[]).includes(required))) {
    throw new Error('cognitum spaces: invalid list envelope');
  }
  if (forbiddenRawField(value.data)) throw new Error('cognitum spaces: forbidden raw field');
  const data = value.data.map((item): CognitumSpaceTwin => {
    if (!record(item) || typeof item.id !== 'string' || !item.id || typeof item.tenantId !== 'string' || !item.tenantId
      || typeof item.siteId !== 'string' || !item.siteId || typeof item.name !== 'string' || !item.name
      || (item.privacy !== 'P2' && item.privacy !== 'P3') || !record(item.state) || item.state.classification !== 'P2'
      || !record(item.provenance)) {
      throw new Error('cognitum spaces: invalid space schema');
    }
    const confidence = item.state.confidence;
    if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error('cognitum spaces: invalid confidence');
    }
    return item as unknown as CognitumSpaceTwin;
  });
  return { data, boundary: boundary as unknown as SpacesBoundary };
}

/** Independently validate the versioned Cognitum API ADR-101 list contract. */
export function validateSpatialResult(value: unknown, expectedKind: SpatialKind): SpatialListResult {
  assertBoundedSemantic(value);
  if (!record(value) || value.object !== 'list' || value.kind !== expectedKind
    || value.schemaVersion !== '1.0' || !Array.isArray(value.data) || value.data.length > MAX_SPACES) {
    throw new Error('cognitum spaces: invalid spatial list envelope');
  }
  const boundary = value.boundary;
  if (!record(boundary) || boundary.authoritativeState !== 'HomeCore Edge'
    || !Array.isArray(boundary.excluded)
    || REQUIRED_EXCLUSIONS.some((required) => !(boundary.excluded as unknown[]).includes(required))) {
    throw new Error('cognitum spaces: invalid spatial list envelope');
  }
  if (value.nextCursor !== null && value.nextCursor !== undefined
    && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 512)) {
    throw new Error('cognitum spaces: invalid spatial cursor');
  }
  const data = value.data.map((item): CognitumSpatialResource => {
    if (!record(item) || !ID_RE.test(String(item.id ?? ''))
      || typeof item.tenantId !== 'string' || !item.tenantId
      || !UUID_RE.test(String(item.workspaceId ?? ''))
      || item.kind !== expectedKind || item.schemaVersion !== '1.0'
      || (item.privacy !== 'P2' && item.privacy !== 'P3')
      || !ID_RE.test(String(item.messageId ?? ''))
      || !Number.isSafeInteger(item.eventSequence) || Number(item.eventSequence) < 0
      || !Number.isSafeInteger(item.version) || Number(item.version) < 1
      || typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt))
      || !record(item.attributes) || !record(item.provenance)) {
      throw new Error('cognitum spaces: invalid spatial resource');
    }
    if (item.confidence !== null && item.confidence !== undefined
      && (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
        || item.confidence < 0 || item.confidence > 1)) {
      throw new Error('cognitum spaces: invalid confidence');
    }
    const required = (field: string): boolean => typeof item[field] === 'string' && Boolean(item[field]);
    if (expectedKind !== 'sites' && !required('siteId')) throw new Error('cognitum spaces: incomplete hierarchy');
    if (expectedKind === 'floors' && !required('buildingId')) throw new Error('cognitum spaces: incomplete hierarchy');
    if (expectedKind === 'spaces' && (!required('buildingId') || !required('floorId'))) {
      throw new Error('cognitum spaces: incomplete hierarchy');
    }
    if (['zones', 'entities', 'events', 'alerts'].includes(expectedKind) && !required('spaceId')) {
      throw new Error('cognitum spaces: incomplete hierarchy');
    }
    if (expectedKind === 'entities'
      && (!['sensor', 'person', 'object', 'track'].includes(String(item.entityType))
        || (['person', 'track'].includes(String(item.entityType)) && item.identityMode !== 'anonymous'))) {
      throw new Error('cognitum spaces: invalid entity privacy contract');
    }
    if (expectedKind === 'events' && !required('eventType')) throw new Error('cognitum spaces: invalid event contract');
    if (expectedKind === 'alerts'
      && (!required('alertType') || !['info', 'warning', 'critical'].includes(String(item.severity))
        || !['open', 'acknowledged', 'resolved'].includes(String(item.status)))) {
      throw new Error('cognitum spaces: invalid alert contract');
    }
    return item as unknown as CognitumSpatialResource;
  });
  return {
    object: 'list', kind: expectedKind, schemaVersion: '1.0', data,
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
    boundary: boundary as unknown as SpacesBoundary,
  };
}

/** Cognitum privacy (P2/P3, the cloud-bridged tiers) → radio-moe PrivacyClass. */
export function privacyOf(p: 'P2' | 'P3'): PrivacyClass {
  return p === 'P3' ? 'sensitive' : 'restricted';
}

const toEpoch = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Map a Cognitum Spaces Envelope to a radio-moe Observation so it flows through
 * `admitObservation` (ADR-402). Only `modelVersion` supplies the calibration
 * identity the fail-closed admission requires; provenance is retained as
 * lineage, never reinterpreted as calibration. Missing fields stay empty so
 * admission rejects them (unknown stays unknown). The `derived` lineage marker
 * prevents a Spaces recollection from authorizing a workflow on a round trip.
 */
export function spacesEnvelopeToObservation(env: CognitumSpacesEnvelope): Observation {
  return {
    sourceId: env.deviceId,
    location: env.siteId,
    kind: env.schema,
    value: env.payload,
    confidence: typeof env.confidence === 'number' ? env.confidence : Number.NaN,
    privacyClass: privacyOf(env.privacy),
    calibrationVersion: env.modelVersion ?? '',
    issuedAt: toEpoch(env.observedAt),
    expiresAt: toEpoch(env.expiresAt),
    lineage: {
      origin: 'cognitum-spaces',
      tenantId: env.tenantId,
      messageId: env.messageId,
      sequence: env.sequence,
      provenance: env.provenance,
      derived: true,
    },
  };
}

/**
 * Map a versioned resource into the same derived-observation admission seam.
 * Missing source/calibration/expiry stays missing, deliberately causing
 * `admitObservation` to reject rather than inventing authority from cloud state.
 */
export function spatialResourceToObservation(resource: CognitumSpatialResource): Observation {
  const sourceId = typeof resource.provenance.sourceId === 'string'
    ? resource.provenance.sourceId : '';
  const calibrationVersion = typeof resource.provenance.modelVersion === 'string'
    ? resource.provenance.modelVersion : '';
  const provenance = typeof resource.provenance.digest === 'string'
    ? resource.provenance.digest : '';
  const kind = resource.eventType ?? resource.alertType ?? `${resource.kind}.state`;
  return {
    sourceId,
    location: resource.spaceId ?? resource.siteId ?? resource.id,
    kind,
    value: resource.attributes,
    confidence: typeof resource.confidence === 'number' ? resource.confidence : Number.NaN,
    privacyClass: privacyOf(resource.privacy),
    calibrationVersion,
    issuedAt: toEpoch(resource.observedAt),
    expiresAt: resource.expiresAt ? toEpoch(resource.expiresAt) : 0,
    lineage: {
      origin: 'cognitum-spaces',
      tenantId: resource.tenantId,
      messageId: resource.messageId,
      sequence: resource.eventSequence,
      provenance,
      derived: true,
    },
  };
}
