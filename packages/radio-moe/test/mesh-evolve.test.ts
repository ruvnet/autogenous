import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerIdentity } from '../src/transport.js';
import {
  evolveMesh,
  evaluate,
  mutate,
  promotable,
  verifyLedger,
  lcg,
  CEILINGS,
  PROMOTION_MARGIN,
  type EvolvableParams,
} from '../src/mesh-evolve.js';
import { DEFAULT_INDEPENDENCE_WEIGHTS } from '../src/lineage-independence.js';

const START: EvolvableParams = { weights: { ...DEFAULT_INDEPENDENCE_WEIGHTS }, quorumThreshold: 2.0 };

test('evolution is deterministic: same seed → identical champion and ledger root', () => {
  const id = PeerIdentity.generate();
  const a = evolveMesh(id, 42, 10, 3);
  const b = evolveMesh(id, 42, 10, 3);
  assert.deepEqual(a.champion, b.champion);
  assert.equal(a.promotions, b.promotions);
  // Different seed explores differently.
  const c = evolveMesh(id, 43, 10, 3);
  assert.notDeepEqual([a.champion, a.promotions], [c.champion, c.promotions]);
});

test('mutations never escape the constitutional ceilings', () => {
  const rnd = lcg(7);
  let p = START;
  for (let i = 0; i < 500; i++) {
    p = mutate(p, rnd);
    for (const v of Object.values(p.weights)) {
      assert.ok(v >= CEILINGS.weightMin && v <= CEILINGS.weightMax, `weight ${v} out of ceiling`);
    }
    assert.ok(p.quorumThreshold >= CEILINGS.quorumMin && p.quorumThreshold <= CEILINGS.quorumMax);
  }
});

test('the hard gates are frozen: gate-breaking params are never promotable', () => {
  // Zeroed weights make a family stack look independent — separation may rise,
  // but the familyStack hard gate MUST disqualify it.
  const degenerate: EvolvableParams = {
    weights: { sameProvider: 0, sameArch: 0, sameSize: 0, sourceJaccard: 0 },
    quorumThreshold: 2.0,
  };
  const fit = evaluate(degenerate);
  assert.equal(fit.hardGatesPass, false, 'family stack reaches quorum → hard gate fails');
  const champion = evaluate(START);
  assert.equal(promotable(fit, champion), false, 'gate-breaking candidate never promotes');
});

test('promotion requires beating the champion by the frozen margin', () => {
  const champ = evaluate(START);
  const equal = { ...champ };
  assert.equal(promotable(equal, champ), false, 'equal fitness does not promote');
  const slightly = { ...champ, separation: champ.separation + PROMOTION_MARGIN / 2 };
  assert.equal(promotable(slightly, champ), false, 'sub-margin lift does not promote');
  const enough = { ...champ, separation: champ.separation + PROMOTION_MARGIN };
  assert.equal(promotable(enough, champ), true);
});

test('every generation is a signed receipt; the ledger chain verifies and tamper breaks it', () => {
  const id = PeerIdentity.generate();
  const r = evolveMesh(id, 42, 8, 3);
  assert.equal(r.history.length, 8);
  assert.equal(r.ledgerFrames.length, 8);
  assert.ok(verifyLedger(r, id.publicKeyDer.toString('hex')));
  // Champion never violates hard gates at any recorded generation.
  assert.ok(r.history.every((h) => h.fitness.hardGatesPass));
  // Tampering one generation record breaks the chain.
  const tampered = { ...r, ledgerFrames: r.ledgerFrames.map((f, i) => (i === 3 ? { ...f, value: 'forged' } : f)) };
  assert.equal(verifyLedger(tampered as typeof r, id.publicKeyDer.toString('hex')), false);
});

test('evolution actually improves separation over generations (measured, seed 42)', () => {
  const id = PeerIdentity.generate();
  const r = evolveMesh(id, 42, 30, 4);
  const startFit = evaluate(START);
  assert.ok(r.promotions >= 1, 'at least one promotion occurred');
  assert.ok(
    r.fitness.separation > startFit.separation,
    `champion ${r.fitness.separation.toFixed(4)} must beat start ${startFit.separation.toFixed(4)}`,
  );
  assert.ok(r.fitness.hardGatesPass, 'final champion passes every hard gate');
});
