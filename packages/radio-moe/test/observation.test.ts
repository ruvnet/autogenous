//! RuField observation admission (ADR-402): fail-closed on any missing required
//! field; expiry + sensor-health gates; confidence→tier mapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { admitObservation, confidenceTier, type Observation } from '../src/index.js';

const NOW = 1_800_000_000_000;
const ok = (): Observation => ({
  sourceId: 'csi-sensor-3',
  location: 'floor-2/room-204',
  kind: 'motion-changed',
  value: { delta: 'stopped' },
  confidence: 0.7,
  privacyClass: 'restricted',
  calibrationVersion: 'cal-2026-08',
  issuedAt: NOW - 1,
  expiresAt: NOW + 30_000,
});

test('a fully-specified observation is admissible', () => {
  assert.deepEqual(admitObservation(ok(), NOW), { admissible: true });
});

test('every required field is fail-closed', () => {
  const cases: [Partial<Observation>, string][] = [
    [{ sourceId: '' }, 'missing-source'],
    [{ location: '' }, 'missing-location'],
    [{ kind: '' }, 'missing-kind'],
    [{ confidence: 1.5 }, 'bad-confidence'],
    [{ confidence: Number.NaN }, 'bad-confidence'],
    [{ privacyClass: 'secret' as never }, 'invalid-privacy-class'],
    [{ calibrationVersion: '' }, 'missing-calibration'],
  ];
  for (const [override, reason] of cases) {
    const d = admitObservation({ ...ok(), ...override }, NOW);
    assert.equal(d.admissible, false, `${reason} should be inadmissible`);
    assert.equal(d.rejection, reason);
  }
});

test('validity window is bounded and current', () => {
  assert.equal(admitObservation({ ...ok(), issuedAt: NOW - 30_000, expiresAt: NOW - 1 }, NOW).rejection, 'expired');
  assert.equal(admitObservation({ ...ok(), issuedAt: NOW + 100_000, expiresAt: NOW + 130_000 }, NOW).rejection, 'expired');
  // window longer than the 5-min default max
  assert.equal(admitObservation({ ...ok(), issuedAt: NOW, expiresAt: NOW + 10 * 60_000 }, NOW).rejection, 'bad-window');
  assert.equal(admitObservation({ ...ok(), expiresAt: NOW - 5 }, NOW).rejection, 'bad-window'); // expires <= issued
});

test('sensor health is gated only when a floor is set', () => {
  // no floor ⇒ sensorHealth optional
  assert.equal(admitObservation(ok(), NOW, {}).admissible, true);
  // floor set, missing health ⇒ fail-closed
  assert.equal(admitObservation(ok(), NOW, { minSensorHealth: 0.5 }).rejection, 'unhealthy-sensor');
  // floor set, below floor ⇒ rejected
  assert.equal(admitObservation({ ...ok(), sensorHealth: 0.3 }, NOW, { minSensorHealth: 0.5 }).rejection, 'unhealthy-sensor');
  // floor set, healthy ⇒ admitted
  assert.equal(admitObservation({ ...ok(), sensorHealth: 0.9 }, NOW, { minSensorHealth: 0.5 }).admissible, true);
});

test('confidence maps to the ADR-402 action tier', () => {
  assert.equal(confidenceTier({ ...ok(), confidence: 0.2 }), 'update-world-model');
  assert.equal(confidenceTier({ ...ok(), confidence: 0.5 }), 'request-more-sensing');
  assert.equal(confidenceTier({ ...ok(), confidence: 0.9 }), 'authorized-workflow');
});

test('Spaces-derived beliefs require valid lineage and cannot authorize a workflow', () => {
  const derived: Observation = {
    ...ok(),
    confidence: 0.99,
    lineage: {
      origin: 'cognitum-spaces',
      tenantId: 'tenant-1',
      messageId: 'message-1',
      sequence: 7,
      provenance: 'edge-fusion',
      derived: true,
    },
  };
  assert.deepEqual(admitObservation(derived, NOW), { admissible: true });
  assert.equal(confidenceTier(derived), 'update-world-model');
  assert.equal(
    admitObservation({ ...derived, lineage: { ...derived.lineage!, tenantId: '' } }, NOW).rejection,
    'invalid-lineage',
  );
  assert.equal(
    admitObservation({ ...derived, lineage: { ...derived.lineage!, sequence: -1 } }, NOW).rejection,
    'invalid-lineage',
  );
});
