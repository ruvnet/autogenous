//! Cognitum identity OAuth — how a user signs in to use Cognitum services.
//!
//! The Cognitum `identity` service (ADR-093) owns the public CLI session flow:
//! `POST /v1/cli/session/exchange` completes a user login and issues a Bearer
//! access token (+ refresh token, org/workspace scope); `GET /v1/cli/services`
//! lists the services that token may use. This module is the client for that
//! flow — a user exchanges their session and the resulting token plugs straight
//! into the Cognitum Spaces client (`bearerAuth`), so the mesh uses Cognitum
//! services under the user's own authenticated identity.
//!
//! Boundary (honest): the exchange completes a login the USER performs (browser
//! sign-in bootstrap); this client sends the exchange request and consumes the
//! token. It never mints tokens or holds user passwords — obtaining the session
//! is the user's out-of-band sign-in.

import { bearerAuth, type CognitumAuth, type FetchLike } from './cognitum-spaces.js';

const DEFAULT_IDENTITY_BASE_URL = 'https://identity-186366152200.us-central1.run.app';

/** The CLI session-exchange request (snake_case on the wire, per the service). */
export interface CliSessionExchangeRequest {
  clientId: string;
  /** Hash binding the request to this install context (never the raw context). */
  installCtxHash: string;
  productCode?: string;
  requestedWorkspaceId?: string;
}

/** A completed Cognitum session — the Bearer token + its scope. */
export interface CliSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accountEmail?: string;
  orgId: string;
  workspaceId: string;
  credentialType: string;
  keyPrefix: string;
  /** Absolute epoch-ms expiry, derived from expiresIn + the exchange time. */
  expiresAt: number;
}

export interface CognitumIdentityConfig {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class CognitumIdentityClient {
  private readonly baseUrl: string;
  constructor(private readonly cfg: CognitumIdentityConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_IDENTITY_BASE_URL).replace(/\/$/, '');
  }

  private get fetchImpl(): FetchLike {
    return this.cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** Complete a user's CLI login → a Bearer session (POST /v1/cli/session/exchange). */
  async exchangeSession(req: CliSessionExchangeRequest, now = Date.now()): Promise<CliSession> {
    const res = await this.post('/v1/cli/session/exchange', {
      client_id: req.clientId,
      install_ctx_hash: req.installCtxHash,
      ...(req.productCode !== undefined ? { product_code: req.productCode } : {}),
      ...(req.requestedWorkspaceId !== undefined ? { requested_workspace_id: req.requestedWorkspaceId } : {}),
    });
    const b = res as Record<string, unknown>;
    const expiresIn = typeof b.expires_in === 'number' ? b.expires_in : 0;
    return {
      accessToken: String(b.access_token ?? ''),
      refreshToken: String(b.refresh_token ?? ''),
      expiresIn,
      ...(typeof b.account_email === 'string' ? { accountEmail: b.account_email } : {}),
      orgId: String(b.org_id ?? ''),
      workspaceId: String(b.workspace_id ?? ''),
      credentialType: String(b.credential_type ?? ''),
      keyPrefix: String(b.key_prefix ?? ''),
      expiresAt: now + expiresIn * 1000,
    };
  }

  /** List the services this Bearer token may use (GET /v1/cli/services). */
  async listServices(bearerToken: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/cli/services`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) throw new Error(`cognitum identity: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    const body = (await res.json()) as { services?: Array<Record<string, unknown>> };
    return body.services ?? [];
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`cognitum identity: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    return res.json();
  }
}

/** Turn a completed session into a Cognitum auth for the Spaces/services clients. */
export function sessionAuth(session: Pick<CliSession, 'accessToken'>): CognitumAuth {
  return bearerAuth(() => session.accessToken);
}

/** True when a session's Bearer token is still valid at `now`. */
export function sessionActive(session: Pick<CliSession, 'expiresAt'>, now = Date.now()): boolean {
  return session.expiresAt > now;
}
