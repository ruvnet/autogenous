import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PeerIdentity } from '../src/transport.js';
import { signFrame, type AgentFrame } from '../src/agent-frame.js';
import { sealBatch, verifyBatch, BatchSigner, MAX_BATCH } from '../src/batch-signing.js';
import { TcpPeerNode, TcpConnection, sealEnvelope, type Envelope } from '../src/tcp-transport.js';

function frame(identity: PeerIdentity, step: number): AgentFrame {
  return signFrame(identity, {
    requestId: 'r', agentId: 'a', step, kind: 'claim', value: `delta-${step}`,
    confidence: 0.5, uncertainty: 0.5, dependencies: [], capabilityUsed: 'x',
    evidenceHashes: [], cost: 0,
  });
}

test('batch seal verifies; tamper, reorder, drop, and wrong key all fail', () => {
  const id = PeerIdentity.generate();
  const key = id.publicKeyDer.toString('hex');
  const frames = Array.from({ length: 8 }, (_, i) => frame(id, i));
  const seal = sealBatch(id, 'r', 'a', 0, frames);

  assert.ok(verifyBatch(seal, frames, key), 'honest batch verifies');
  const tampered = frames.map((f, i) => (i === 3 ? { ...f, value: 'poison' } : f));
  assert.equal(verifyBatch(seal, tampered, key), false, 'tamper breaks the chain');
  assert.equal(verifyBatch(seal, [...frames.slice(1), frames[0]!], key), false, 'reorder breaks');
  assert.equal(verifyBatch(seal, frames.slice(0, 7), key), false, 'drop breaks (count)');
  const other = PeerIdentity.generate().publicKeyDer.toString('hex');
  assert.equal(verifyBatch(seal, frames, other), false, 'wrong key fails');
  assert.throws(() => sealBatch(id, 'r', 'a', 0, Array.from({ length: MAX_BATCH + 1 }, (_, i) => frame(id, i))), /outside/);
});

test('BatchSigner emits bounded seals + a flush tail, indices contiguous', () => {
  const id = PeerIdentity.generate();
  const signer = new BatchSigner(id, 'r', 'a', 4);
  const seals = [];
  const frames = Array.from({ length: 10 }, (_, i) => frame(id, i));
  for (const f of frames) {
    const s = signer.push(f);
    if (s) seals.push(s);
  }
  const tail = signer.flush();
  if (tail) seals.push(tail);
  assert.deepEqual(seals.map((s) => [s.startIndex, s.count]), [[0, 4], [4, 4], [8, 2]]);
  const key = id.publicKeyDer.toString('hex');
  assert.ok(verifyBatch(seals[0]!, frames.slice(0, 4), key));
  assert.ok(verifyBatch(seals[1]!, frames.slice(4, 8), key));
  assert.ok(verifyBatch(seals[2]!, frames.slice(8, 10), key));
});

test('TcpConnection streams many envelopes over ONE socket, in order', async () => {
  const origin = PeerIdentity.generate();
  const receiver = PeerIdentity.generate();
  const accepted: Envelope[] = [];
  const node = new TcpPeerNode({
    identity: receiver,
    trustedPeers: { [origin.peerId]: origin.publicKeyDer.toString('hex') },
    onEnvelope: (e) => accepted.push(e),
  });
  const port = await node.listen(0);
  const conn = new TcpConnection('127.0.0.1', port);
  try {
    for (let i = 1; i <= 20; i++) {
      await conn.send(sealEnvelope(origin, {
        recipientPeer: receiver.peerId, requestId: 'req', routeEpoch: 1,
        senderSequence: i, kind: 'stream.delta', payload: { i },
      }));
    }
    const t0 = Date.now();
    while (accepted.length < 20 && Date.now() - t0 < 2000) await sleep(10);
    assert.equal(accepted.length, 20);
    assert.deepEqual(accepted.map((e) => e.senderSequence), Array.from({ length: 20 }, (_, i) => i + 1));
  } finally {
    conn.close();
    await node.close();
  }
});
