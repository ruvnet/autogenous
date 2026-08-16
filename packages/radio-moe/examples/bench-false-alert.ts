//! Sensor false-alert bench (ADR-402 cond 3): does fusing sensors cut false
//! alerts vs the best single sensor?
//!
//! Spatial intelligence's core value claim: independent-corroboration fusion
//! reduces false alerts. We model heterogeneous sensors that each fire on real
//! events but also throw INDEPENDENT false positives on benign situations. A
//! single sensor's false positives all count; the fused detector only alerts when
//! independent sensors corroborate (lineage `effectiveSupport` ≥ quorum), so one
//! sensor's isolated false positive is not enough — while a real event, seen by
//! several independent sensors, still clears the bar.
//!
//! Deterministic (seeded LCG, no randomness). Only ADMISSIBLE observations
//! (`admitObservation`, ADR-402) count — a malformed/expired reading is dropped
//! before it can raise a false alert. Run: `node --import tsx examples/bench-false-alert.ts`.

import { effectiveSupport, type LineageSupport, type ModelLineage } from '../src/lineage-independence.js';
import { admitObservation, type Observation } from '../src/observation.js';

const NOW = 1_800_000_000_000;

interface Sensor { id: string; lineage: ModelLineage; fpRate: number; fnRate: number; }
const SENSORS: Sensor[] = [
  { id: 'csi-a', lineage: { provider: 'wifi', arch: 'csi', sizeClass: 'M', modelId: 'csi-a' }, fpRate: 0.25, fnRate: 0.1 },
  { id: 'radar-b', lineage: { provider: 'radar', arch: 'fmcw', sizeClass: 'L', modelId: 'radar-b' }, fpRate: 0.2, fnRate: 0.1 },
  { id: 'ble-c', lineage: { provider: 'ble', arch: 'rssi', sizeClass: 'S', modelId: 'ble-c' }, fpRate: 0.3, fnRate: 0.15 },
  { id: 'pir-d', lineage: { provider: 'pir', arch: 'ir', sizeClass: 'S', modelId: 'pir-d' }, fpRate: 0.25, fnRate: 0.12 },
  { id: 'cam-e', lineage: { provider: 'camera', arch: 'cnn', sizeClass: 'XL', modelId: 'cam-e' }, fpRate: 0.15, fnRate: 0.08 },
];

interface Situation { id: string; real: boolean; }
// 40 situations, alternating real / benign (deterministic, balanced).
const SITUATIONS: Situation[] = Array.from({ length: 40 }, (_, i) => ({ id: `sit-${i}`, real: i % 2 === 0 }));

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function draw(sensorId: string, sit: string): number {
  // one deterministic draw per (sensor, situation) — independent across sensors
  let s = seedOf(`${sensorId}:${sit}`);
  s = (Math.imul(1664525, s) + 1013904223) >>> 0;
  return s / 0x100000000;
}

/** Does this sensor fire an alert on this situation? Real ⇒ fires unless a false
 *  negative; benign ⇒ fires only on a false positive (independent per sensor). */
function fires(sensor: Sensor, sit: Situation): boolean {
  const d = draw(sensor.id, sit.id);
  return sit.real ? d >= sensor.fnRate : d < sensor.fpRate;
}

/** A sensor's firing, as an admissible observation (malformed ⇒ dropped). */
function observe(sensor: Sensor, sit: Situation): Observation | null {
  const obs: Observation = {
    sourceId: sensor.id, location: 'room-1', kind: 'alert',
    value: { situation: sit.id }, confidence: 0.8, privacyClass: 'restricted',
    calibrationVersion: 'cal-1', issuedAt: NOW - 1, expiresAt: NOW + 30_000, sensorHealth: 0.95,
  };
  return admitObservation(obs, NOW, { minSensorHealth: 0.5 }).admissible ? obs : null;
}

const rate = (hits: number, n: number) => (n === 0 ? 0 : hits / n);

export interface FalseAlertReport {
  situations: number;
  benign: number;
  perSensorFalseAlert: { id: string; rate: number }[];
  /** "No fusion" for a wired multi-sensor deployment: alert if ANY sensor fires. */
  unionFalseAlert: number;
  unionDetection: number;
  fusedFalseAlert: number;
  fusedDetection: number;
  /** Reported for context: the single lowest-false-alert sensor. */
  bestSingleFalseAlert: number;
  bestSingleDetection: number;
  reductionVsUnion: number;
  detectionRetained: boolean;
  meetsHalfReduction: boolean;
  corroborationQuorum: number;
}

/** Fused alert = independent corroboration: effectiveSupport of the firing
 *  sensors (that produced an admissible observation) clears the quorum. */
function fusedAlert(sit: Situation, quorum: number): boolean {
  const supporters: LineageSupport[] = SENSORS.filter((s) => fires(s, sit) && observe(s, sit) !== null).map((s) => ({
    agentId: s.id, principalId: s.id, lineage: s.lineage, sourceIds: [`src-${s.id}`],
  }));
  return supporters.length > 0 && effectiveSupport(supporters) >= quorum;
}

/** No-fusion baseline for a wired fleet: alert if ANY admissible sensor fires. */
function anyFires(sit: Situation): boolean {
  return SENSORS.some((s) => fires(s, sit) && observe(s, sit) !== null);
}

export function runFalseAlertBench(corroborationQuorum = 2.0): FalseAlertReport {
  const benign = SITUATIONS.filter((s) => !s.real);
  const real = SITUATIONS.filter((s) => s.real);

  const perSensorFalseAlert = SENSORS.map((s) => ({
    id: s.id,
    rate: rate(benign.filter((sit) => fires(s, sit) && observe(s, sit) !== null).length, benign.length),
  }));
  const bestSingle = perSensorFalseAlert.reduce((a, b) => (b.rate < a.rate ? b : a));
  const bestSingleSensor = SENSORS.find((s) => s.id === bestSingle.id)!;
  const bestSingleDetection = rate(real.filter((sit) => fires(bestSingleSensor, sit)).length, real.length);

  const unionFalseAlert = rate(benign.filter(anyFires).length, benign.length);
  const unionDetection = rate(real.filter(anyFires).length, real.length);
  const fusedFalseAlert = rate(benign.filter((sit) => fusedAlert(sit, corroborationQuorum)).length, benign.length);
  const fusedDetection = rate(real.filter((sit) => fusedAlert(sit, corroborationQuorum)).length, real.length);

  const reduction = unionFalseAlert === 0 ? 0 : (unionFalseAlert - fusedFalseAlert) / unionFalseAlert;
  return {
    situations: SITUATIONS.length,
    benign: benign.length,
    perSensorFalseAlert,
    unionFalseAlert,
    unionDetection,
    fusedFalseAlert,
    fusedDetection,
    bestSingleFalseAlert: bestSingle.rate,
    bestSingleDetection,
    reductionVsUnion: reduction,
    detectionRetained: fusedDetection >= unionDetection - 0.01,
    meetsHalfReduction: reduction >= 0.5,
    corroborationQuorum,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runFalseAlertBench();
  console.log(`\n── Sensor false-alert fusion (${r.situations} situations, ${r.benign} benign, ${SENSORS.length} sensors) ──`);
  for (const s of r.perSensorFalseAlert.sort((a, b) => a.rate - b.rate)) console.log(`  sensor ${s.id.padEnd(9)} false-alert ${pct(s.rate)}`);
  console.log(`  no-fusion (any sensor):   ${pct(r.unionFalseAlert)}  (detection ${pct(r.unionDetection)})`);
  console.log(`  FUSED (corroborated):     ${pct(r.fusedFalseAlert)}  (detection ${pct(r.fusedDetection)})`);
  console.log(`  best single sensor (ctx): ${pct(r.bestSingleFalseAlert)}  (detection ${pct(r.bestSingleDetection)})`);
  console.log(`  false-alert reduction vs no-fusion: ${pct(r.reductionVsUnion)}  → target ≥50% ${r.meetsHalfReduction ? 'PASS' : 'FAIL'}`);
  console.log(`  detection retained: ${r.detectionRetained ? 'PASS' : 'FAIL'}  (corroboration quorum: effectiveSupport ≥ ${r.corroborationQuorum})`);
}
