//! RuField typed observation contract + fail-closed admission (ADR-402).
//!
//! ADR-402's load-bearing rule: RuView reports an OBSERVATION; Cognitum Spaces
//! maintains BELIEF. The dominant failure mode is Spaces turning a weak
//! observation into authoritative world state. The fix is structural uncertainty:
//! **no observation becomes admissible evidence without source identity, location,
//! confidence, privacy class, calibration version, and expiry — and unknown must
//! remain unknown.** This module is that seam: the typed inbound contract the
//! perception layer (RuField) fills, and `admitObservation`, which rejects (fail-
//! closed) any observation missing a required field, expired, or from an unhealthy
//! sensor. It never *asserts* belief — it decides admissibility.
//!
//! `confidenceTier` maps ADR-402 §5's tiers: a low-confidence observation may only
//! update the world model; medium may request more sensing; high may trigger a
//! workflow — but the top tier is NECESSARY, not sufficient: an authorized action
//! still requires independent corroboration at the `ActionGate` (this module does
//! not grant that).

export type PrivacyClass = 'public' | 'internal' | 'restricted' | 'sensitive';
const PRIVACY_CLASSES: readonly PrivacyClass[] = ['public', 'internal', 'restricted', 'sensitive'];

/** A single timestamped perception, before it is admitted as evidence. */
export interface Observation {
  /** Sensor/agent identity that produced this observation. */
  sourceId: string;
  /** Where it was observed (zone/room/asset id). */
  location: string;
  /** What was observed (person-detected, motion-changed, rf-anomaly, …). */
  kind: string;
  value: unknown;
  /** Observation confidence in [0, 1]. */
  confidence: number;
  privacyClass: PrivacyClass;
  /** Sensor calibration identity — no fact without it (structural uncertainty). */
  calibrationVersion: string;
  issuedAt: number;
  /** Observations expire; a stale observation is not a current fact. */
  expiresAt: number;
  /** Optional sensor-health signal in [0, 1]; gated when a floor is set. */
  sensorHealth?: number;
}

export type ObservationRejection =
  | 'missing-source'
  | 'missing-location'
  | 'missing-kind'
  | 'bad-confidence'
  | 'invalid-privacy-class'
  | 'missing-calibration'
  | 'bad-window'
  | 'expired'
  | 'unhealthy-sensor';

export interface ObservationAdmission {
  admissible: boolean;
  rejection?: ObservationRejection;
}

export interface ObservationPolicy {
  /** Reject if `sensorHealth` is below this (and, when set, require it present). */
  minSensorHealth?: number;
  /** Maximum validity window (ms). Default 5 min — observations are perishable. */
  maxTtlMs?: number;
  /** Clock skew tolerance (ms). Default 5 s. */
  clockSkewMs?: number;
}

const DEFAULT_MAX_TTL_MS = 5 * 60_000;
const DEFAULT_CLOCK_SKEW_MS = 5_000;
const finiteUnit = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * Fail-closed admissibility: every required field must be present and valid, the
 * validity window bounded and current, and the sensor healthy enough. A missing
 * or malformed field is NOT admitted — unknown stays unknown.
 */
export function admitObservation(obs: Observation, now: number, policy: ObservationPolicy = {}): ObservationAdmission {
  const maxTtl = policy.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  const skew = policy.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (!obs.sourceId) return { admissible: false, rejection: 'missing-source' };
  if (!obs.location) return { admissible: false, rejection: 'missing-location' };
  if (!obs.kind) return { admissible: false, rejection: 'missing-kind' };
  if (!finiteUnit(obs.confidence)) return { admissible: false, rejection: 'bad-confidence' };
  if (!PRIVACY_CLASSES.includes(obs.privacyClass)) return { admissible: false, rejection: 'invalid-privacy-class' };
  if (!obs.calibrationVersion) return { admissible: false, rejection: 'missing-calibration' };
  if (
    !Number.isSafeInteger(obs.issuedAt) ||
    !Number.isSafeInteger(obs.expiresAt) ||
    obs.expiresAt <= obs.issuedAt ||
    obs.expiresAt - obs.issuedAt > maxTtl
  ) {
    return { admissible: false, rejection: 'bad-window' };
  }
  if (obs.issuedAt > now + skew || now >= obs.expiresAt) return { admissible: false, rejection: 'expired' };
  if (policy.minSensorHealth !== undefined) {
    if (!finiteUnit(obs.sensorHealth) || obs.sensorHealth < policy.minSensorHealth) {
      return { admissible: false, rejection: 'unhealthy-sensor' };
    }
  }
  return { admissible: true };
}

export type ActionTier = 'update-world-model' | 'request-more-sensing' | 'authorized-workflow';

export interface TierThresholds {
  /** confidence < low ⇒ update world model only. Default 0.4. */
  low: number;
  /** confidence >= high ⇒ eligible for a workflow (still needs corroboration). Default 0.75. */
  high: number;
}

/**
 * ADR-402 §5 confidence tier. NOTE: `authorized-workflow` is the *eligibility*
 * tier — an actual authorized action ALSO requires independent corroboration at
 * the `ActionGate`. This function does not grant authority; it classifies.
 */
export function confidenceTier(obs: Observation, thresholds: TierThresholds = { low: 0.4, high: 0.75 }): ActionTier {
  if (obs.confidence >= thresholds.high) return 'authorized-workflow';
  if (obs.confidence >= thresholds.low) return 'request-more-sensing';
  return 'update-world-model';
}
