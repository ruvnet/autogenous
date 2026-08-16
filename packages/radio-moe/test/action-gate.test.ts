import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActionGate,
  actionIdentity,
  signActionSupport,
  type ActionGateOptions,
  type ActionSupport,
  type GovernedAction,
  type UnsignedActionSupport,
} from '../src/action-gate.js';
import { PeerIdentity } from '../src/transport.js';

const NOW = 1_800_000_000_000;
const action: GovernedAction = {
  capability: 'repo.write',
  tool: 'apply_patch',
  target: 'src/service.ts',
  arguments: { patch: { after: 2, before: 1 } },
  jurisdiction: 'project:ruflo',
};

function trusted(...identities: PeerIdentity[]): Map<string, string> {
  return new Map(identities.map((identity) => [identity.peerId, identity.publicKeyDer.toString('hex')]));
}

function support(identity: PeerIdentity, overrides: Partial<UnsignedActionSupport> = {}): ActionSupport {
  return signActionSupport(identity, {
    agentId: identity.peerId,
    principalId: `principal-${identity.peerId}`,
    modelId: `model-${identity.peerId}`,
    sourceIds: [`source-${identity.peerId}`],
    evidenceHashes: [`evidence-${identity.peerId}`],
    calibration: 0.8,
    risk: 0.2,
    action,
    issuedAt: NOW - 1,
    expiresAt: NOW + 10_000,
    ...overrides,
  });
}

function gate(identities: PeerIdentity[], overrides: Partial<ActionGateOptions> = {}): ActionGate {
  return new ActionGate({
    minimumQuorum: 2,
    riskThreshold: 0.5,
    admissible: () => true,
    trustedSigners: trusted(...identities),
    ...overrides,
  });
}

test('action identity is canonical, binds authority fields, and rejects lossy JSON values', () => {
  const reordered: GovernedAction = {
    jurisdiction: 'project:ruflo',
    arguments: { patch: { before: 1, after: 2 } },
    target: 'src/service.ts',
    tool: 'apply_patch',
    capability: 'repo.write',
  };
  assert.equal(actionIdentity(action), actionIdentity(reordered));
  assert.notEqual(actionIdentity(action), actionIdentity({ ...action, target: 'src/other.ts' }));
  assert.throws(() => actionIdentity({ ...action, arguments: { x: undefined } }), /canonical JSON/);
  assert.throws(() => actionIdentity({ ...action, arguments: { x: Number.NaN } }), /finite/);
  assert.throws(() => actionIdentity({ ...action, arguments: { x: Infinity } }), /finite/);
  assert.throws(() => actionIdentity({ ...action, arguments: { x: () => true } }), /canonical JSON/);
  assert.throws(() => actionIdentity({ ...action, arguments: { x: 1n } }), /canonical JSON/);
  const sparse = new Array(2);
  sparse[1] = 'x';
  assert.throws(() => actionIdentity({ ...action, arguments: sparse }), /sparse/);
  const symbolKeyed = { ok: true, [Symbol('hidden')]: 1 };
  assert.throws(() => actionIdentity({ ...action, arguments: symbolKeyed }), /symbol keys/);
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
  assert.throws(() => actionIdentity({ ...action, arguments: accessor }), /data properties/);
});

test('independent signed, admitted, admissible support releases an action', async () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const decision = await gate([a, b]).evaluate(action, [support(a), support(b)], NOW);
  assert.equal(decision.execute, true);
  assert.deepEqual(decision.independentSupport.map((item) => item.agentId).sort(), [a.peerId, b.peerId].sort());
});

test('forged, unadmitted, expired, and evidence-free supports fail closed', async () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const actionGate = gate([a, b]);
  const forged = { ...support(a), risk: 0.1 };
  await assert.rejects(() => actionGate.evaluate(action, [forged, support(b)], NOW), /signature/);

  const stranger = PeerIdentity.generate();
  await assert.rejects(() => actionGate.evaluate(action, [support(stranger), support(b)], NOW), /not admitted/);
  await assert.rejects(
    () => actionGate.evaluate(action, [support(a, { expiresAt: NOW }), support(b)], NOW),
    /not currently valid/,
  );
  await assert.rejects(
    () => actionGate.evaluate(action, [support(a, { evidenceHashes: [] }), support(b)], NOW),
    /evidenceHashes must be non-empty/,
  );
  await assert.rejects(
    () => actionGate.evaluate(action, [support(a, { sourceIds: [] }), support(b)], NOW),
    /sourceIds must be non-empty/,
  );
});

test('shared authority/model/source/evidence cannot manufacture false consensus', async () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const actionGate = gate([a, b]);
  const first = support(a);
  for (const correlated of [
    support(b, { sourceIds: first.sourceIds }),
    support(b, { modelId: first.modelId }),
    support(b, { evidenceHashes: first.evidenceHashes }),
    support(b, { principalId: first.principalId }),
  ]) {
    const decision = await actionGate.evaluate(action, [first, correlated], NOW);
    assert.equal(decision.execute, false);
    assert.equal(decision.rejection, 'insufficient-independent-quorum');
    assert.equal(decision.independentSupport.length, 1);
  }
});

test('risk threshold and admissibility fail closed', async () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  assert.equal(
    (await gate([a, b]).evaluate(action, [support(a), support(b, { risk: 0.5 })], NOW)).rejection,
    'risk-threshold',
  );
  assert.equal(
    (await gate([a, b], { admissible: async () => false }).evaluate(action, [support(a), support(b)], NOW)).rejection,
    'inadmissible',
  );
});

test('authenticated mismatched actions are filtered instead of vetoing a valid quorum', async () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const c = PeerIdentity.generate();
  const mismatch = support(c, { action: { ...action, target: 'src/other.ts' } });
  const decision = await gate([a, b, c]).evaluate(action, [support(a), mismatch, support(b)], NOW);
  assert.equal(decision.execute, true);
  assert.equal(decision.mismatchedSupport, 1);
  assert.equal(decision.independentSupport.length, 2);
});

test('policy and trust roots are cloned and cannot be weakened by caller mutation', async () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const signerMap = trusted(a, b);
  const options: ActionGateOptions = {
    minimumQuorum: 2,
    riskThreshold: 0.5,
    admissible: () => true,
    trustedSigners: signerMap,
  };
  const actionGate = new ActionGate(options);
  options.minimumQuorum = 1;
  options.riskThreshold = 1;
  signerMap.clear();
  const one = await actionGate.evaluate(action, [support(a)], NOW);
  assert.equal(one.execute, false);
  assert.equal(one.rejection, 'insufficient-independent-quorum');
  assert.equal((await actionGate.evaluate(action, [support(a), support(b)], NOW)).execute, true);
});

test('support selection is deterministic and bounded', async () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const c = PeerIdentity.generate();
  const sa = support(a, { calibration: 0.7000004 });
  const sb = support(b, { calibration: 0.9000004, sourceIds: ['shared'] });
  const sc = support(c, { calibration: 0.6000004, sourceIds: ['shared'] });
  const actionGate = gate([a, b, c]);
  const first = await actionGate.evaluate(action, [sc, sa, sb], NOW);
  const second = await actionGate.evaluate(action, [sb, sc, sa], NOW);
  assert.deepEqual(first.independentSupport.map((item) => item.agentId), second.independentSupport.map((item) => item.agentId));

  const bounded = gate([a, b], { maxSupports: 2 });
  await assert.rejects(() => bounded.evaluate(action, [sa, sb, sa], NOW), /too many/);
});
