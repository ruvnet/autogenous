import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerIdentity, seal, verifySealed } from '../src/transport.js';
import type { TextFrame } from '../src/types.js';

const frame = (peerId: string): TextFrame => ({
  kind: 'text', chunkId: 'c#0', expertId: 'e', peerId, seq: 0, tokens: 'hi', final: true,
});

test('a sealed wire verifies; a tampered payload does not', () => {
  const id = PeerIdentity.generate();
  const sealed = seal(id, frame(id.peerId));
  assert.ok(verifySealed(sealed), 'honest frame verifies');

  const tampered = structuredClone(sealed);
  (tampered.wire as TextFrame).tokens = 'malicious';
  assert.equal(verifySealed(tampered), false, 'edited content breaks the signature');
});

test('a spoofed peerId (key/fingerprint mismatch) is rejected', () => {
  const a = PeerIdentity.generate();
  const b = PeerIdentity.generate();
  const sealed = seal(a, frame(a.peerId));
  // Claim to be peer b while carrying a's key: fingerprint no longer matches peerId.
  const spoof = { ...sealed, peerId: b.peerId };
  assert.equal(verifySealed(spoof), false);
});

test("a frame whose inner peerId disagrees with the envelope is rejected", () => {
  const a = PeerIdentity.generate();
  // Sign a frame that claims a DIFFERENT origin than the signer.
  const sealed = seal(a, frame('someone-else'));
  assert.equal(verifySealed(sealed), false, 'inner/outer peerId must agree');
});
