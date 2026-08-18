//! Cognitum identity OAuth (ADR-093): the CLI session exchange yields a Bearer
//! session that authenticates the Spaces/services clients. Offline (injected
//! fetch) — a live exchange needs the user's real sign-in and is out of scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CognitumIdentityClient,
  sessionAuth,
  sessionActive,
  type CognitumFetchLike,
} from '../src/index.js';

const NOW = 1_800_000_000_000;

// Mirrors the identity service's CliSessionExchangeResponse (snake_case wire).
const EXCHANGE_BODY = {
  access_token: 'acc_live_123',
  refresh_token: 'ref_456',
  expires_in: 3600,
  account_email: 'user@example.com',
  org_id: 'org-1',
  workspace_id: 'ws-1',
  credential_type: 'cli-session',
  key_prefix: 'cog_ab',
};

test('exchangeSession posts the snake_case request and parses the Bearer session', async () => {
  const seen: { url: string; body: string | undefined }[] = [];
  const fake: CognitumFetchLike = async (url, init) => {
    seen.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => EXCHANGE_BODY, text: async () => '' };
  };
  const client = new CognitumIdentityClient({ baseUrl: 'https://id.example', fetchImpl: fake });
  const session = await client.exchangeSession({ clientId: 'cli-1', installCtxHash: 'h-abc', productCode: 'spaces' }, NOW);

  assert.equal(seen[0]!.url, 'https://id.example/v1/cli/session/exchange');
  const sent = JSON.parse(seen[0]!.body!);
  assert.equal(sent.client_id, 'cli-1');
  assert.equal(sent.install_ctx_hash, 'h-abc');
  assert.equal(sent.product_code, 'spaces');

  assert.equal(session.accessToken, 'acc_live_123');
  assert.equal(session.orgId, 'org-1');
  assert.equal(session.expiresIn, 3600);
  assert.equal(session.expiresAt, NOW + 3600_000);
  assert.equal(session.accountEmail, 'user@example.com');
});

test('a session becomes a Cognitum auth that carries the Bearer token', async () => {
  const client = new CognitumIdentityClient({ baseUrl: 'https://id.example', fetchImpl: async () => ({ ok: true, status: 200, json: async () => EXCHANGE_BODY, text: async () => '' }) });
  const session = await client.exchangeSession({ clientId: 'cli-1', installCtxHash: 'h' }, NOW);
  const auth = sessionAuth(session);
  assert.deepEqual(auth(), { authorization: 'Bearer acc_live_123' });

  // This token is client_id=cognitum-cli. It is intentionally NOT exercised
  // against Spaces, whose resource policy requires aud/client_id=ruview and
  // spaces:read from the PKCE activation flow.
});

test('sessionActive respects expiry', () => {
  assert.equal(sessionActive({ expiresAt: NOW + 1000 }, NOW), true);
  assert.equal(sessionActive({ expiresAt: NOW - 1 }, NOW), false);
});

test('a failed exchange throws with the status', async () => {
  const client = new CognitumIdentityClient({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'login required' }) });
  await assert.rejects(() => client.exchangeSession({ clientId: 'c', installCtxHash: 'h' }, NOW), /HTTP 401/);
});
