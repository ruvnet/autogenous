import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PeerIdentity,
  seal,
  verifySealed,
  verifyAdmitted,
  AdmittedPeerRegistry,
} from '../src/transport.js';
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

// ── P1 #5: possession is not admission ──

test('verifyAdmitted accepts an admitted peer and rejects a validly-signed but un-admitted one', () => {
  const admitted = PeerIdentity.generate();
  const stranger = PeerIdentity.generate(); // well-formed keypair, never admitted
  const reg = new AdmittedPeerRegistry();
  reg.admitIdentity(admitted);

  const good = seal(admitted, frame(admitted.peerId));
  const strangerFrame = seal(stranger, frame(stranger.peerId));

  // Both are validly SEALED (possession proven)…
  assert.ok(verifySealed(good) && verifySealed(strangerFrame));
  // …but only the admitted peer passes the admission gate.
  assert.equal(verifyAdmitted(good, reg), true, 'admitted peer accepted');
  assert.equal(
    verifyAdmitted(strangerFrame, reg),
    false,
    'a valid signature is not admission',
  );

  // A tampered frame from an admitted peer still fails (signature check first).
  const tampered = structuredClone(good);
  (tampered.wire as TextFrame).tokens = 'evil';
  assert.equal(verifyAdmitted(tampered, reg), false);
});

test('an admitted peerId cannot be impersonated with a different key', () => {
  const real = PeerIdentity.generate();
  const reg = new AdmittedPeerRegistry();
  reg.admitIdentity(real);
  // A frame that carries a different key can never claim real.peerId (fingerprint
  // mismatch fails verifySealed); and a frame from a different peerId is not admitted.
  const other = PeerIdentity.generate();
  assert.equal(verifyAdmitted(seal(other, frame(other.peerId)), reg), false);
  // Revocation removes admission.
  reg.revoke(real.peerId);
  assert.equal(verifyAdmitted(seal(real, frame(real.peerId)), reg), false, 'revoked peer rejected');
});

test('admitting a peerId that does not match its key fingerprint throws', () => {
  const a = PeerIdentity.generate();
  const reg = new AdmittedPeerRegistry();
  assert.throws(
    () => reg.admit('deadbeefdeadbeef', a.publicKeyDer.toString('hex')),
    /fingerprints to/,
    'a nonsensical (peerId,key) admission is refused',
  );
});
