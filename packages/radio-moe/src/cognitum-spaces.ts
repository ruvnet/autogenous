//! Cognitum Spaces adapter — connect the mesh to the DEPLOYED Cognitum Spaces
//! service (ADR-402's world-model layer, made real).
//!
//! ADR-402 specified Cognitum Spaces as the external spatial world-model the mesh
//! plugs into. It is deployed behind the Cognitum API gateway at
//! `GET /v1/spaces`. This adapter reads spatial twin
//! state over that REST surface and maps a Cognitum Spaces **Envelope** to a
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
    return k?.startsWith('cog_') ? { 'x-api-key': k } : {};
  };
}

/** Bearer auth; callers must supply a RuView OAuth `spaces:read` access token. */
export function bearerAuth(getToken: () => string | undefined): CognitumAuth {
  return () => {
    const t = getToken();
    return t ? { authorization: `Bearer ${t}` } : {};
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

/** The deployed Cognitum Spaces gateway route (verified live with a `cog_` key). */
const DEFAULT_BASE_URL = 'https://api.cognitum.one';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SPACES = 100;
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

  /** GET /v1/spaces — the caller's authorized spatial twins. Returns just the
   *  twin list; use {@link listSpacesResult} for the privacy boundary too. */
  async listSpaces(): Promise<CognitumSpaceTwin[]> {
    return (await this.listSpacesResult()).data;
  }

  /** GET /v1/spaces — the full Stripe-style list result, INCLUDING the service's
   *  `boundary` (what raw sensing it deliberately excludes from the cloud — the
   *  ADR-402 "raw sensing stays local" enforcement, verifiable at the edge). */
  async listSpacesResult(): Promise<SpacesListResult> {
    const fetchImpl = this.cfg.fetchImpl ?? (globalThis.fetch as unknown as CognitumFetchLike);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${this.baseUrl}/v1/spaces`, {
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
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new Error('cognitum spaces: malformed JSON'); }
    return validateSpacesResult(body);
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

function forbiddenRawField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenRawField);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return ['rawcsi', 'cir', 'rftensors', 'recordings', 'poseframes', 'vitalwaveforms', 'identityobservations'].includes(normalized)
      || forbiddenRawField(child);
  });
}

export function validateSpacesResult(value: unknown): SpacesListResult {
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
