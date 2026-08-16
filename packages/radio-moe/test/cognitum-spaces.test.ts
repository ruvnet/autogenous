//! Cognitum Spaces adapter (ADR-402): envelope→observation mapping, auth headers,
//! and listSpaces over an injected fetch. A LIVE test hits the deployed service
//! only when COGNITUM_API_KEY is set (otherwise it skips).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CognitumSpacesClient,
  spacesEnvelopeToObservation,
  privacyOf,
  apiKeyAuth,
  bearerAuth,
  admitObservation,
  type CognitumSpacesEnvelope,
  type CognitumFetchLike,
} from '../src/index.js';

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
  // flows through the ADR-402 fail-closed admission at a time inside its window
  const now = Date.parse('2026-08-16T18:00:10.000Z');
  assert.equal(admitObservation(obs, now).admissible, true);
});

test('privacy tiers and missing calibration are fail-closed downstream', () => {
  assert.equal(privacyOf('P3'), 'sensitive');
  assert.equal(privacyOf('P2'), 'restricted');
  const { modelVersion: _mv, ...noModel } = ENVELOPE;
  const noCal = spacesEnvelopeToObservation({ ...noModel, provenance: '' });
  const now = Date.parse('2026-08-16T18:00:10.000Z');
  assert.equal(admitObservation(noCal, now).rejection, 'missing-calibration');
});

test('auth headers: cog_ key vs Bearer, read at call time', () => {
  assert.deepEqual(apiKeyAuth(() => 'cog_abc')(), { 'x-api-key': 'cog_abc' });
  assert.deepEqual(apiKeyAuth(() => undefined)(), {});
  assert.deepEqual(bearerAuth(() => 'idtok')(), { authorization: 'Bearer idtok' });
});

test('listSpaces parses the real {object:list, data, boundary} shape + auth (injected fetch)', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  // The exact live shape observed from the deployed service.
  const fake: CognitumFetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({
        object: 'list',
        data: [{ spaceId: 's1', connection: 'connected', twinStatus: 'live' }],
        boundary: { authoritativeState: 'HomeCore Edge', excluded: ['raw_csi', 'pose_frames', 'vital_waveforms'] },
      }),
    };
  };
  const client = new CognitumSpacesClient({ baseUrl: 'https://gw.example', auth: apiKeyAuth(() => 'cog_xyz'), fetchImpl: fake });
  assert.equal(client.hasCredentials(), true);
  const result = await client.listSpacesResult();
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]!.spaceId, 's1');
  assert.deepEqual(result.boundary?.excluded, ['raw_csi', 'pose_frames', 'vital_waveforms']);
  assert.equal(seen[0]!.url, 'https://gw.example/v1/spaces');
  assert.equal(seen[0]!.headers['x-api-key'], 'cog_xyz');
  // legacy convenience: listSpaces() returns just the data array
  assert.equal((await client.listSpaces()).length, 1);
});

test('a non-ok response throws with the status', async () => {
  const fake: CognitumFetchLike = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' });
  const client = new CognitumSpacesClient({ auth: apiKeyAuth(() => undefined), fetchImpl: fake });
  assert.equal(client.hasCredentials(), false);
  await assert.rejects(() => client.listSpaces(), /HTTP 401/);
});

test('LIVE: GET /v1/spaces against the deployed service (skips without COGNITUM_API_KEY)', async (t) => {
  const key = process.env.COGNITUM_API_KEY;
  if (!key) { t.skip('COGNITUM_API_KEY not set — live Cognitum Spaces test skipped'); return; }
  const client = new CognitumSpacesClient({ auth: apiKeyAuth(() => key) });
  const result = await client.listSpacesResult(); // throws on non-2xx
  assert.ok(Array.isArray(result.data), 'live /v1/spaces returns a twin list');
  // The live service reports the cloud/edge privacy boundary — raw sensing is
  // excluded from the cloud (ADR-402 "raw sensing stays local", verified live).
  if (result.boundary?.excluded) {
    assert.ok(result.boundary.excluded.length > 0, 'boundary excludes raw sensing kinds');
  }
});
