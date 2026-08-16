//! Cognitum Spaces adapter — connect the mesh to the DEPLOYED Cognitum Spaces
//! service (ADR-402's world-model layer, made real).
//!
//! ADR-402 specified Cognitum Spaces as the external spatial world-model the mesh
//! plugs into. It is deployed on GCP (`spacesapi` Cloud Run; gateway route
//! `GET /v1/spaces`), `cog_`-key / Bearer authed. This adapter reads spatial twin
//! state over that REST surface and maps a Cognitum Spaces **Envelope** to a
//! radio-moe **Observation**, so real spatial state flows through `admitObservation`
//! (the same fail-closed admission — no fact without confidence/privacy/expiry).
//!
//! Auth ("Cognitum OAuth for users") is supplied by the caller: a `cog_` API key
//! (`X-API-Key`) or a Bearer token (a Firebase ID / OAuth access token from the
//! Cognitum `identity` service). Keys are read from the environment AT CALL TIME —
//! never hardcoded, never logged. `hasCredentials()` lets a caller skip cleanly
//! when no key is configured.

import type { Observation, PrivacyClass } from './observation.js';

/** Returns the auth headers for a Cognitum request (may be empty if unconfigured). */
export type CognitumAuth = () => Record<string, string>;

/** cog_ API-key auth (X-API-Key). Key is read at call time. */
export function apiKeyAuth(getKey: () => string | undefined): CognitumAuth {
  return () => {
    const k = getKey();
    return k ? { 'x-api-key': k } : {};
  };
}

/** Bearer-token auth (Firebase ID token / OAuth access token from `identity`). */
export function bearerAuth(getToken: () => string | undefined): CognitumAuth {
  return () => {
    const t = getToken();
    return t ? { authorization: `Bearer ${t}` } : {};
  };
}

/** Convenience: read a `cog_` key from an env var (default COGNITUM_API_KEY). */
export function envApiKeyAuth(envVar = 'COGNITUM_API_KEY'): CognitumAuth {
  return apiKeyAuth(() => process.env[envVar]);
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface CognitumSpacesConfig {
  /** Default: the deployed `spacesapi` service (serves `/v1/spaces` directly).
   *  Override to route through the API gateway or a staging deployment. */
  baseUrl?: string;
  auth: CognitumAuth;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/** The deployed Cognitum Spaces service (verified live: `GET /v1/spaces` → 200
 *  with a cog_ key). Override via `baseUrl` for gateway/staging routing. */
const DEFAULT_BASE_URL = 'https://spacesapi-186366152200.us-central1.run.app';

/** A spatial twin as returned by `GET /v1/spaces` (fields typed loosely — the
 *  service owns the schema; we map the stable ones). */
export interface CognitumSpaceTwin {
  spaceId?: string;
  siteId?: string;
  deviceId?: string;
  connection?: 'connected' | 'degraded' | 'offline' | 'unknown';
  twinStatus?: 'live' | 'delayed' | 'stale' | 'unavailable';
  observedAt?: string | null;
  expiresAt?: string | null;
  confidence?: number;
  privacy?: 'P2' | 'P3';
  provenance?: string;
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
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  /** True when auth headers are present (a key/token is configured). */
  hasCredentials(): boolean {
    return Object.keys(this.cfg.auth()).length > 0;
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
    const fetchImpl = this.cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const res = await fetchImpl(`${this.baseUrl}/v1/spaces`, {
      method: 'GET',
      headers: { accept: 'application/json', ...this.cfg.auth() },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`cognitum spaces: HTTP ${res.status} ${detail}`.trim());
    }
    const body = (await res.json()) as Record<string, unknown> | CognitumSpaceTwin[];
    // Real shape: { object:'list', data:[...], boundary:{...} }. Tolerate a bare
    // array and a legacy `spaces` key.
    const data = Array.isArray(body)
      ? body
      : ((body.data as CognitumSpaceTwin[] | undefined) ?? (body.spaces as CognitumSpaceTwin[] | undefined) ?? []);
    const boundary = !Array.isArray(body) ? (body.boundary as SpacesBoundary | undefined) : undefined;
    return { data, ...(boundary ? { boundary } : {}) };
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
  boundary?: SpacesBoundary;
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
 * `admitObservation` (ADR-402). Cognitum's `provenance`/`modelVersion` supply the
 * calibration identity the fail-closed admission requires; missing fields stay
 * empty so admission rejects them (unknown stays unknown).
 */
export function spacesEnvelopeToObservation(env: CognitumSpacesEnvelope): Observation {
  return {
    sourceId: env.deviceId,
    location: env.siteId,
    kind: env.schema,
    value: env.payload,
    confidence: typeof env.confidence === 'number' ? env.confidence : 0,
    privacyClass: privacyOf(env.privacy),
    calibrationVersion: env.modelVersion ?? env.provenance ?? '',
    issuedAt: toEpoch(env.observedAt),
    expiresAt: toEpoch(env.expiresAt),
  };
}
