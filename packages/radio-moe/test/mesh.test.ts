import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Fabric,
  InMemorySignedTransport,
  PeerIdentity,
  AdmittedPeerRegistry,
} from '../src/transport.js';
import type { DataTransport, SignedWire } from '../src/transport.js';
import { Peer } from '../src/mesh.js';
import { LogitExpert, TextExpert } from '../src/expert.js';
import type { Chunk } from '../src/types.js';

const VOCAB = 'v1';
const SIZE = 4;
const oneHot = (i: number, scale = 3): number[] =>
  Array.from({ length: SIZE }, (_, k) => (k === i ? scale : 0));

function mesh3(): { peers: Peer[]; fabric: Fabric } {
  const fabric = new Fabric();
  const peers = [0, 1, 2].map(() => {
    const id = PeerIdentity.generate();
    return new Peer(id, new InMemorySignedTransport(id, fabric), { topK: 2, tau: 0.4 });
  });
  return { peers, fabric };
}

test('logit experts across peers are routed, dispatched, and truly mixed', () => {
  const { peers } = mesh3();
  const [a, b, c] = peers as [Peer, Peer, Peer];
  // Each peer hosts one logit expert on a shared vocab; capability = its token.
  a.host(new LogitExpert('e0', oneHot(0, 1), VOCAB, SIZE, () => oneHot(0)));
  b.host(new LogitExpert('e1', oneHot(1, 1), VOCAB, SIZE, () => oneHot(1)));
  c.host(new LogitExpert('e2', oneHot(2, 1), VOCAB, SIZE, () => oneHot(2)));

  // Route from A a chunk leaning toward token 0, then token 1.
  const chunk: Chunk = { streamId: 's', seq: 0, features: [0.9, 0.7, 0, 0] };
  const res = a.route(chunk, 'logit');

  assert.equal(res.decision.routed.length, 2, 'topK=2');
  assert.equal(res.merged.kind, 'logit');
  assert.equal(res.metrics.dataFrames, 2, 'both experts streamed a frame back');
  assert.equal(res.metrics.rejectedFrames, 0);
  assert.ok(res.metrics.controlMessages >= 1, 'a routing decision was logged on the control plane');
  if (res.merged.kind === 'logit') {
    // The mixed distribution is Σ wᵢ·logitsᵢ — argmax is one of the two chosen tokens.
    assert.deepEqual(
      res.merged.tokens,
      [res.decision.routed[0]!.expertId === 'e0' ? 0 : 1],
    );
  }
  // A learned the remote experts over the signed advert wire.
  assert.ok(a.gate.known().some((x) => x.expertId === 'e1' && x.peerId === b.peerId));
});

test('a peer with an admission allowlist learns only admitted peers (P1 #5)', () => {
  const fabric = new Fabric();
  const admittedId = PeerIdentity.generate();
  const strangerId = PeerIdentity.generate(); // valid keypair, never admitted
  const receiverId = PeerIdentity.generate();

  const reg = new AdmittedPeerRegistry();
  reg.admitIdentity(admittedId);
  // Only the receiver enforces admission; the other two just broadcast adverts.
  const receiver = new Peer(
    receiverId,
    new InMemorySignedTransport(receiverId, fabric),
    { topK: 2, tau: 0.4 },
    reg,
  );
  const admitted = new Peer(admittedId, new InMemorySignedTransport(admittedId, fabric), {
    topK: 2,
    tau: 0.4,
  });
  const stranger = new Peer(strangerId, new InMemorySignedTransport(strangerId, fabric), {
    topK: 2,
    tau: 0.4,
  });

  admitted.host(new LogitExpert('e-admitted', oneHot(0, 1), VOCAB, SIZE, () => oneHot(0)));
  stranger.host(new LogitExpert('e-stranger', oneHot(1, 1), VOCAB, SIZE, () => oneHot(1)));

  const known = receiver.gate.known();
  assert.ok(
    known.some((x) => x.expertId === 'e-admitted' && x.peerId === admittedId.peerId),
    'admitted peer is learned',
  );
  assert.ok(
    !known.some((x) => x.expertId === 'e-stranger'),
    'a validly-signed but UN-admitted peer is dropped, never learned',
  );
  // Ensure `receiver` is used (its transport is the enforcement point).
  assert.equal(receiver.peerId, receiverId.peerId);
});

test('heterogeneous text experts race (ensemble), highest gate weight wins', () => {
  const { peers } = mesh3();
  const [a, b] = peers as [Peer, Peer, Peer];
  a.host(new TextExpert('writer', [1, 0, 0, 0], (ch) => `A says: ${ch.text}`));
  b.host(new TextExpert('editor', [0.2, 1, 0, 0], (ch) => `B says: ${ch.text}`));

  const chunk: Chunk = { streamId: 's', seq: 1, features: [0.1, 0.95, 0, 0], text: 'hello' };
  const res = a.route(chunk, 'text');
  assert.equal(res.merged.kind, 'text');
  if (res.merged.kind === 'text') {
    assert.equal(res.merged.outcome.regime, 'text-ensemble', 'labelled an ensemble, not MoE');
    assert.equal(res.merged.outcome.winner.expertId, 'editor', 'weight-aligned expert wins');
    assert.equal(res.merged.outcome.winner.text, 'B says: hello');
  }
});

test('a route where the dispatched expert lives on its own peer folds a self-mention', () => {
  const { peers } = mesh3();
  const [a] = peers as [Peer, Peer, Peer];
  a.host(new TextExpert('local', [1, 0, 0, 0], () => 'local answer'));
  const res = a.route({ streamId: 's', seq: 2, features: [1, 0, 0, 0], text: 'q' }, 'text');
  // The routing message @-mentions the chosen peer (== self here), so the
  // passive watcher folds it in this same step boundary.
  assert.ok(res.discoveries.length >= 1, 'teammate/self discovery folded via AgentRadio');
  assert.ok(a.controlLog().some((l) => l.includes('route')), 'control plane recorded the route');
});

/** A malicious owner that corrupts the DATA frames it streams back (leaving the
 *  advert/dispatch control wires intact so it is still discoverable). */
class TamperingTransport implements DataTransport {
  readonly peerId: string;
  constructor(private readonly inner: InMemorySignedTransport) {
    this.peerId = inner.peerId;
  }
  send(sealed: SignedWire, to?: string): void {
    if (sealed.wire.kind === 'logit' || sealed.wire.kind === 'text') {
      const bad = structuredClone(sealed);
      if (bad.wire.kind === 'logit') bad.wire.logits[0] = (bad.wire.logits[0] ?? 0) + 1;
      else if (bad.wire.kind === 'text') bad.wire.tokens += 'X';
      this.inner.send(bad, to); // signature no longer matches the mutated payload
      return;
    }
    this.inner.send(sealed, to);
  }
  onWire(h: (s: SignedWire) => void): void {
    this.inner.onWire(h);
  }
  peers(): string[] {
    return this.inner.peers();
  }
  leave(): void {
    this.inner.leave();
  }
}

test('frames with a broken signature are dropped and counted, never mixed', () => {
  const fabric = new Fabric();
  const routerId = PeerIdentity.generate();
  const router = new Peer(routerId, new InMemorySignedTransport(routerId, fabric), { topK: 1, tau: 1 });
  const evilId = PeerIdentity.generate();
  const evilInner = new InMemorySignedTransport(evilId, fabric);
  const evil = new Peer(evilId, new TamperingTransport(evilInner), { topK: 1, tau: 1 });
  evil.host(new LogitExpert('bad', oneHot(3, 1), VOCAB, SIZE, () => oneHot(3)));

  const res = router.route({ streamId: 's', seq: 0, features: [0, 0, 0, 1] }, 'logit');
  assert.equal(res.decision.routed[0]!.expertId, 'bad', 'router selected the evil expert');
  assert.ok(res.metrics.rejectedFrames >= 1, 'the tampered frame was counted as rejected');
  assert.equal(res.metrics.dataFrames, 0, 'and it was NOT applied to the mixture');
  if (res.merged.kind === 'logit') assert.equal(res.merged.tokens.length, 0, 'no tokens from unverified data');
});
