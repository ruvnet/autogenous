//! TLS peer transport: a sealed envelope round-trips over an encrypted socket, and
//! a tampered envelope is still rejected — integrity survives on top of
//! confidentiality. Generates a throwaway self-signed cert via openssl; if openssl
//! is unavailable the TLS handshake test skips (the framing/verify logic is already
//! covered by tcp-transport.test.ts, which shares sealEnvelope/verifyEnvelope).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TlsPeerNode, tlsSendEnvelope, sealEnvelope, type Envelope, type RejectReason } from '../src/index.js';
import { PeerIdentity } from '../src/transport.js';

function selfSignedCert(): { key: string; cert: string; dir: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'radio-moe-tls-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem'), 'utf-8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf-8'), dir };
  } catch {
    return null;
  }
}

test('a sealed envelope round-trips over TLS; a tampered one is rejected', async (t) => {
  const pki = selfSignedCert();
  if (!pki) { t.skip('openssl unavailable — TLS handshake test skipped (framing covered by tcp tests)'); return; }

  const node = PeerIdentity.generate();
  const origin = PeerIdentity.generate();
  const accepted: Envelope[] = [];
  const rejected: RejectReason[] = [];
  let onAccept: (() => void) | null = null;
  let onRejectFired: (() => void) | null = null;

  const peer = new TlsPeerNode(
    {
      identity: node,
      trustedPeers: { [origin.peerId]: origin.publicKeyDer.toString('hex') },
      onEnvelope: (e) => { accepted.push(e); onAccept?.(); },
      onReject: (r) => { rejected.push(r); onRejectFired?.(); },
    },
    { key: pki.key, cert: pki.cert },
  );

  try {
    const port = await peer.listen(0);
    const clientTls = { ca: [pki.cert], checkServerIdentity: () => undefined };

    // 1) a valid sealed envelope survives the encrypted channel.
    const good = sealEnvelope(origin, {
      recipientPeer: node.peerId, requestId: 'req-1', routeEpoch: 1, senderSequence: 1,
      kind: 'request.open', payload: { prompt: 'over tls' },
    });
    const gotGood = new Promise<void>((res) => { onAccept = res; });
    await tlsSendEnvelope('127.0.0.1', port, good, clientTls);
    await Promise.race([gotGood, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.eventId, good.eventId);

    // 2) tampering after signing is rejected — integrity holds over TLS too.
    const tampered = { ...sealEnvelope(origin, {
      recipientPeer: node.peerId, requestId: 'req-1', routeEpoch: 1, senderSequence: 2,
      kind: 'stream.delta', payload: { text: 'original' },
    }), payload: { text: 'swapped' } };
    const gotReject = new Promise<void>((res) => { onRejectFired = res; });
    await tlsSendEnvelope('127.0.0.1', port, tampered as Envelope, clientTls);
    await Promise.race([gotReject, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    assert.equal(accepted.length, 1, 'tampered envelope must NOT be accepted');
    assert.ok(rejected.length >= 1, 'tampered envelope must be rejected');
  } finally {
    await peer.close();
    rmSync(pki.dir, { recursive: true, force: true });
  }
});
