//! Loopback conformance for the signed TCP reference adapter (ADR-395 §9,
//! acceptance criteria 3/4/5/9, and ADR-396's acceptance walk).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PeerIdentity } from '../src/transport.js';
import {
  TcpPeerNode,
  sealEnvelope,
  sendEnvelope,
  verifyEnvelope,
  ReplayGuard,
  MAX_FRAME_BYTES,
  type Envelope,
  type RejectReason,
} from '../src/tcp-transport.js';

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await sleep(10);
  }
}

function fixture() {
  const origin = PeerIdentity.generate();
  const expertPeer = PeerIdentity.generate();
  const accepted: Envelope[] = [];
  const rejected: { reason: RejectReason; eventId?: string }[] = [];
  const node = new TcpPeerNode({
    identity: expertPeer,
    trustedPeers: { [origin.peerId]: origin.publicKeyDer.toString('hex') },
    onEnvelope: (e) => accepted.push(e),
    onReject: (reason, meta) =>
      rejected.push({ reason, ...(meta.eventId !== undefined ? { eventId: meta.eventId } : {}) }),
  });
  return { origin, expertPeer, node, accepted, rejected };
}

function open(origin: PeerIdentity, recipient: string, seq: number, payload: unknown = { prompt: 'p' }): Envelope {
  return sealEnvelope(origin, {
    recipientPeer: recipient,
    requestId: 'req-1',
    routeEpoch: 1,
    senderSequence: seq,
    kind: 'request.open',
    payload,
  });
}

test('a full request.open → stream.delta → stream.end round trip over REAL loopback TCP', async () => {
  const { origin, expertPeer, node, accepted } = fixture();
  const port = await node.listen(0);
  try {
    await sendEnvelope('127.0.0.1', port, open(origin, expertPeer.peerId, 1));
    const delta = sealEnvelope(origin, {
      recipientPeer: expertPeer.peerId,
      requestId: 'req-1',
      routeEpoch: 1,
      senderSequence: 2,
      kind: 'stream.delta',
      payload: { text: 'chunk' },
    });
    await sendEnvelope('127.0.0.1', port, delta);
    await sendEnvelope(
      '127.0.0.1',
      port,
      sealEnvelope(origin, {
        recipientPeer: expertPeer.peerId,
        requestId: 'req-1',
        routeEpoch: 1,
        senderSequence: 3,
        kind: 'stream.end',
        payload: {},
      }),
    );
    await waitFor(() => accepted.length === 3);
    assert.deepEqual(accepted.map((e) => e.kind), ['request.open', 'stream.delta', 'stream.end']);
  } finally {
    await node.close();
  }
});

test('ADR-396 acceptance walk: replay, tampered byte, lower sequence — exactly ONE invocation', async () => {
  const { origin, expertPeer, node, accepted, rejected } = fixture();
  const port = await node.listen(0);
  try {
    const valid = open(origin, expertPeer.peerId, 5);
    await sendEnvelope('127.0.0.1', port, valid); // 1: valid → accepted

    // 2: the SAME envelope again → replayed-event, before any invocation.
    await sendEnvelope('127.0.0.1', port, valid);

    // 3: one changed payload byte → signature no longer matches.
    const tampered = { ...valid, payload: { prompt: 'q' } };
    await sendEnvelope('127.0.0.1', port, tampered as Envelope);

    // 4: freshly signed but LOWER sequence → stale-sequence.
    await sendEnvelope('127.0.0.1', port, open(origin, expertPeer.peerId, 4));

    await waitFor(() => rejected.length === 3);
    assert.equal(accepted.length, 1, 'exactly one expert invocation may occur');
    assert.deepEqual(
      rejected.map((r) => r.reason).sort(),
      ['bad-signature', 'replayed-event', 'stale-sequence'],
    );
    // Rejections expose ids + reason class only — never payload content.
    assert.ok(rejected.every((r) => !JSON.stringify(r).includes('prompt')));
  } finally {
    await node.close();
  }
});

test('a forged envelope (unknown sender key) never invokes the handler', async () => {
  const { origin, expertPeer, node, accepted, rejected } = fixture();
  const mallory = PeerIdentity.generate(); // NOT in trustedPeers
  const port = await node.listen(0);
  try {
    await sendEnvelope('127.0.0.1', port, open(mallory, expertPeer.peerId, 1));
    // An envelope claiming origin's peerId but signed by mallory → bad-signature.
    const forged = { ...open(mallory, expertPeer.peerId, 2), senderPeer: origin.peerId };
    await sendEnvelope('127.0.0.1', port, forged as Envelope);
    await waitFor(() => rejected.length === 2);
    assert.equal(accepted.length, 0);
    assert.deepEqual(rejected.map((r) => r.reason).sort(), ['bad-signature', 'unknown-sender']);
  } finally {
    await node.close();
  }
});

test('expired and wrong-recipient envelopes are rejected; oversized frames drop the connection', async () => {
  const { origin, expertPeer, node, accepted, rejected } = fixture();
  const port = await node.listen(0);
  try {
    // Expired: sealed with issuedAt in the deep past.
    const expired = sealEnvelope(
      origin,
      { recipientPeer: expertPeer.peerId, requestId: 'req-1', routeEpoch: 1, senderSequence: 1, kind: 'request.open', payload: {}, ttlMs: 1 },
      Date.now() - 60_000,
    );
    await sendEnvelope('127.0.0.1', port, expired);
    // Wrong recipient.
    await sendEnvelope('127.0.0.1', port, open(origin, 'someone-else', 2));
    await waitFor(() => rejected.length === 2);
    assert.deepEqual(rejected.map((r) => r.reason).sort(), ['expired-or-skewed', 'wrong-recipient']);
    assert.equal(accepted.length, 0);

    // Oversized: sender-side bound refuses to even transmit it.
    const huge = open(origin, expertPeer.peerId, 3, { blob: 'x'.repeat(MAX_FRAME_BYTES) });
    await assert.rejects(() => sendEnvelope('127.0.0.1', port, huge), /MAX_FRAME_BYTES/);
  } finally {
    await node.close();
  }
});

test('verifyEnvelope order: shape rejects before any crypto; replay guard is per-(sender,request)', () => {
  const origin = PeerIdentity.generate();
  const self = PeerIdentity.generate();
  const ctx = {
    selfPeerId: self.peerId,
    trustedPeers: { [origin.peerId]: origin.publicKeyDer.toString('hex') },
    replay: new ReplayGuard(),
  };
  assert.equal(verifyEnvelope({ nonsense: true }, ctx), 'bad-shape');
  const e1 = open(origin, self.peerId, 1);
  assert.equal(verifyEnvelope(e1, ctx), null);
  // Same sequence on a DIFFERENT request is fine (tuple-scoped monotonicity).
  const otherReq = sealEnvelope(origin, {
    recipientPeer: self.peerId, requestId: 'req-2', routeEpoch: 1, senderSequence: 1,
    kind: 'request.open', payload: {},
  });
  assert.equal(verifyEnvelope(otherReq, ctx), null);
});
