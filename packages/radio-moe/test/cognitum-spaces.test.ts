//! Cognitum Spaces adapter (ADR-402): envelope→observation mapping, auth headers,
//! and listSpaces over an injected fetch. A LIVE test hits the deployed service
//! only when COGNITUM_SPACES_API is set (otherwise it skips).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CognitumSpacesClient,
  spacesEnvelopeToObservation,
  spatialResourceToObservation,
  privacyOf,
  apiKeyAuth,
  bearerAuth,
  admitObservation,
  confidenceTier,
  type CognitumSpacesEnvelope,
  type CognitumSpatialResource,
  type CognitumFetchLike,
} from '../src/index.js';

const REQUIRED_EXCLUSIONS_FOR_TEST = [
  'raw_csi', 'cir', 'rf_tensors', 'recordings', 'pose_frames',
  'vital_waveforms', 'identity_observations',
];

const ENVELOPE: CognitumSpacesEnvelope = {
  schema: 'motion-changed',
  messageId: 'm-1',
  sequence: 3,
  tenantId: 't-1',
  siteId: 'floor-2/room-204',
  deviceId: 'csi-sensor-3',
  observedAt: '2026-08-16T18:00:00.000Z',
  expiresAt: '2026-08-16T18:00:30.000Z',
  privacy: 'P2',
  provenance: 'edge-fusion',
  confidence: 0.72,
  modelVersion: 'cal-2026-08',
  payload: { delta: 'stopped' },
};

test('a Spaces envelope maps to an admissible Observation', () => {
  const obs = spacesEnvelopeToObservation(ENVELOPE);
  assert.equal(obs.sourceId, 'csi-sensor-3');
  assert.equal(obs.location, 'floor-2/room-204');
  assert.equal(obs.confidence, 0.72);
  assert.equal(obs.privacyClass, 'restricted'); // P2
  assert.equal(obs.calibrationVersion, 'cal-2026-08');
  assert.deepEqual(obs.lineage, {
    origin: 'cognitum-spaces', tenantId: 't-1', messageId: 'm-1', sequence: 3,
    provenance: 'edge-fusion', derived: true,
  });
  // flows through the ADR-402 fail-closed admission at a time inside its window
  const now = Date.parse('2026-08-16T18:00:10.000Z');
  assert.equal(admitObservation(obs, now).admissible, true);
  assert.equal(confidenceTier(obs), 'update-world-model');
});

test('privacy tiers and missing calibration are fail-closed downstream', () => {
  assert.equal(privacyOf('P3'), 'sensitive');
  assert.equal(privacyOf('P2'), 'restricted');
  const { modelVersion: _mv, ...noModel } = ENVELOPE;
  const noCal = spacesEnvelopeToObservation({ ...noModel, provenance: 'not-a-calibration' });
  const now = Date.parse('2026-08-16T18:00:10.000Z');
  assert.equal(admitObservation(noCal, now).rejection, 'missing-calibration');
});

test('auth headers: cog_ key vs Bearer, read at call time', () => {
  assert.deepEqual(apiKeyAuth(() => 'cog_abc')(), { 'x-api-key': 'cog_abc' });
  assert.deepEqual(apiKeyAuth(() => undefined)(), {});
  assert.deepEqual(apiKeyAuth(() => 'cog_bad\r\nheader')(), {});
  assert.deepEqual(bearerAuth(() => 'idtok')(), { authorization: 'Bearer idtok' });
  assert.deepEqual(bearerAuth(() => 'bad token')(), {});
});

test('listSpaces parses the real {object:list, data, boundary} shape + auth (injected fetch)', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  // The exact live shape observed from the deployed service.
  const fake: CognitumFetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        object: 'list',
        data: [{ id: 's1', tenantId: 't1', siteId: 'site1', name: 'Room', connection: 'connected', status: 'live', privacy: 'P2', state: { confidence: 0.8, occupancy: 1, classification: 'P2' }, provenance: {} }],
        boundary: { authoritativeState: 'HomeCore Edge', excluded: ['raw_csi', 'cir', 'rf_tensors', 'recordings', 'pose_frames', 'vital_waveforms', 'identity_observations'] },
      }),
      json: async () => ({}),
    };
  };
  const client = new CognitumSpacesClient({ baseUrl: 'https://gw.example', auth: apiKeyAuth(() => 'cog_xyz'), fetchImpl: fake });
  assert.equal(client.hasCredentials(), true);
  const result = await client.listSpacesResult();
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]!.id, 's1');
  assert.equal(result.boundary.excluded?.length, 7);
  assert.equal(seen[0]!.url, 'https://gw.example/v1/spaces');
  assert.equal(seen[0]!.headers['x-api-key'], 'cog_xyz');
  // legacy convenience: listSpaces() returns just the data array
  assert.equal((await client.listSpaces()).length, 1);
});

test('versioned hierarchy/events are paged and remain derived evidence', async () => {
  const seen: string[] = [];
  const event: CognitumSpatialResource = {
    id: 'event-1', tenantId: 'tenant-1', workspaceId: '11111111-1111-4111-8111-111111111111',
    kind: 'events', schemaVersion: '1.0', privacy: 'P2', messageId: 'message-1',
    eventSequence: 7, version: 1, siteId: 'site-1', spaceId: 'room-1',
    eventType: 'occupancy.changed', observedAt: '2026-08-19T10:00:00Z',
    expiresAt: '2026-08-19T10:01:00Z', confidence: 0.8,
    attributes: { occupancy: 2 },
    provenance: { sourceId: 'sensor-1', modelVersion: 'cal-1', digest: 'witness-1' },
  };
  const fake: CognitumFetchLike = async (url) => {
    seen.push(url);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        object: 'list', kind: 'events', schemaVersion: '1.0', data: [event], nextCursor: 'next-1',
        boundary: { authoritativeState: 'HomeCore Edge', excluded: [...REQUIRED_EXCLUSIONS_FOR_TEST] },
      }),
      json: async () => ({}),
    };
  };
  const client = new CognitumSpacesClient({
    baseUrl: 'https://gw.example', auth: bearerAuth(() => 'ruview-oauth'), fetchImpl: fake,
  });
  const result = await client.listSpatial('events', { limit: 25, cursor: 'prior' });
  assert.equal(result.data[0]!.eventType, 'occupancy.changed');
  assert.equal(result.nextCursor, 'next-1');
  assert.equal(seen[0], 'https://gw.example/v1/spatial/events?limit=25&cursor=prior');

  const observation = spatialResourceToObservation(event);
  assert.ok(observation.lineage);
  assert.equal(observation.lineage.derived, true);
  assert.equal(observation.lineage.messageId, 'message-1');
  assert.equal(admitObservation(observation, Date.parse('2026-08-19T10:00:30Z')).admissible, true);
  assert.notEqual(confidenceTier(observation), 'authorized-workflow');
});

test('versioned client binds API keys to a UUID workspace and validates kind-specific privacy', async () => {
  const never: CognitumFetchLike = async () => { throw new Error('must not fetch'); };
  const client = new CognitumSpacesClient({ auth: apiKeyAuth(() => 'cog_key'), fetchImpl: never });
  await assert.rejects(() => client.listSpatial('sites'), /require workspace id/);
  await assert.rejects(
    () => client.listSpatial('sites', { workspaceId: 'not-a-uuid' }),
    /invalid workspace id/,
  );
  await assert.rejects(
    () => client.listSpatial('sites', { workspaceId: '11111111-1111-7111-8111-111111111111' }),
    /must not fetch/,
  );

  const invalidEntity = {
    object: 'list', kind: 'entities', schemaVersion: '1.0', nextCursor: null,
    boundary: { authoritativeState: 'HomeCore Edge', excluded: [...REQUIRED_EXCLUSIONS_FOR_TEST] },
    data: [{
      id: 'person-1', tenantId: 'tenant-1', workspaceId: '11111111-1111-4111-8111-111111111111',
      kind: 'entities', schemaVersion: '1.0', privacy: 'P2', messageId: 'm-1',
      eventSequence: 1, version: 1, siteId: 'site-1', spaceId: 'space-1',
      entityType: 'person', identityMode: 'named', observedAt: '2026-08-19T10:00:00Z',
      attributes: {}, provenance: {},
    }],
  };
  const response: CognitumFetchLike = async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(invalidEntity), json: async () => ({}),
  });
  const oauth = new CognitumSpacesClient({ auth: bearerAuth(() => 'token'), fetchImpl: response });
  await assert.rejects(() => oauth.listSpatial('entities'), /entity privacy contract/);
  invalidEntity.data[0]!.identityMode = 'anonymous';
  (invalidEntity.data[0] as Record<string, unknown>).attributes = { packet_capture: 'raw' };
  await assert.rejects(() => oauth.listSpatial('entities'), /forbidden raw field/);
});

test('client rejects unsafe URLs, limits, and ambiguous credentials', async () => {
  assert.throws(
    () => new CognitumSpacesClient({ baseUrl: 'http://example.test', auth: () => ({}) }),
    /HTTPS required/,
  );
  assert.throws(
    () => new CognitumSpacesClient({ baseUrl: 'https://user:pass@example.test', auth: () => ({}) }),
    /invalid base URL/,
  );
  assert.throws(
    () => new CognitumSpacesClient({ auth: () => ({}), maxResponseBytes: 9 * 1024 * 1024 }),
    /invalid response limit/,
  );
  const client = new CognitumSpacesClient({
    auth: () => ({ 'x-api-key': 'cog_x', authorization: 'Bearer token', host: 'attacker.test' }),
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(client.hasCredentials(), false);
  await assert.rejects(() => client.listSpaces(), /ambiguous credentials/);
});

test('strict validation rejects legacy casts, raw fields, and bad confidence', async () => {
  const response = (body: unknown): CognitumFetchLike => async () => ({
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  });
  for (const body of [
    [{ id: 'legacy-array' }],
    { object: 'list', data: [], boundary: { authoritativeState: 'HomeCore Edge', excluded: ['raw_csi'] } },
    { object: 'list', data: [{ id: 's', tenantId: 't', siteId: 'site', name: 'n', privacy: 'P2', state: { confidence: 2, classification: 'P2' }, provenance: {} }], boundary: { authoritativeState: 'HomeCore Edge', excluded: [...REQUIRED_EXCLUSIONS_FOR_TEST] } },
    { object: 'list', data: [{ id: 's', tenantId: 't', siteId: 'site', name: 'n', privacy: 'P2', state: { confidence: 0.5, classification: 'P2', raw_csi: 'leak' }, provenance: {} }], boundary: { authoritativeState: 'HomeCore Edge', excluded: [...REQUIRED_EXCLUSIONS_FOR_TEST] } },
  ]) {
    const client = new CognitumSpacesClient({ auth: apiKeyAuth(() => 'cog_x'), fetchImpl: response(body) });
    await assert.rejects(() => client.listSpaces(), /cognitum spaces:/);
  }
});

test('response media type and byte limit fail closed', async () => {
  const wrongType: CognitumFetchLike = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name === 'content-type' ? 'text/html' : null },
    json: async () => ({}),
    text: async () => '<html>not json</html>',
  });
  await assert.rejects(
    () => new CognitumSpacesClient({ auth: apiKeyAuth(() => 'cog_x'), fetchImpl: wrongType }).listSpaces(),
    /unexpected content type/,
  );

  const oversized: CognitumFetchLike = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name === 'content-length' ? '4096' : 'application/json' },
    json: async () => ({}),
    text: async () => '{}',
  });
  await assert.rejects(
    () => new CognitumSpacesClient({ auth: apiKeyAuth(() => 'cog_x'), fetchImpl: oversized, maxResponseBytes: 1024 }).listSpaces(),
    /response too large/,
  );
});

test('a non-ok response throws with the status', async () => {
  const fake: CognitumFetchLike = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' });
  const client = new CognitumSpacesClient({ auth: apiKeyAuth(() => undefined), fetchImpl: fake });
  assert.equal(client.hasCredentials(), false);
  await assert.rejects(() => client.listSpaces(), /HTTP 401/);
});

test('LIVE: GET /v1/spaces against the deployed service (skips without COGNITUM_SPACES_API)', async (t) => {
  const key = process.env.COGNITUM_SPACES_API;
  if (!key) { t.skip('COGNITUM_SPACES_API not set — live Cognitum Spaces test skipped'); return; }
  const client = new CognitumSpacesClient({ auth: apiKeyAuth(() => key) });
  const result = await client.listSpacesResult(); // throws on non-2xx
  assert.ok(Array.isArray(result.data), 'live /v1/spaces returns a twin list');
  // The live service reports the cloud/edge privacy boundary — raw sensing is
  // excluded from the cloud (ADR-402 "raw sensing stays local", verified live).
  if (result.boundary?.excluded) {
    assert.ok(result.boundary.excluded.length > 0, 'boundary excludes raw sensing kinds');
  }
});
