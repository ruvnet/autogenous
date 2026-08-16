//! TLS peer transport — confidentiality on top of the signed-envelope integrity.
//!
//! The signed TCP transport (`tcp-transport.ts`) gives integrity + authenticity
//! (ed25519 per envelope, replay/sequence checks) but sends cleartext on the wire.
//! Production needs **confidentiality** too. This is the same envelope logic over a
//! `node:tls` socket instead of `node:net`: `sealEnvelope`/`verifyEnvelope`/
//! `ReplayGuard`/`frameOf` are reused verbatim (a `TLSSocket` IS a `net.Socket`),
//! so the security-critical path is not duplicated — only the socket changes.
//!
//! PKI is the deployer's, not the mesh's: the caller supplies `tls` server/client
//! options (key/cert, and `ca` + `requestCert`/`rejectUnauthorized` for mutual
//! auth). The reference does not ship or generate certificates.

import { createServer, connect, type TLSSocket, type TlsOptions, type ConnectionOptions } from 'node:tls';
import type { Server } from 'node:net';
import {
  MAX_FRAME_BYTES,
  ReplayGuard,
  frameOf,
  verifyEnvelope,
  type Envelope,
  type TcpNodeOptions,
} from './tcp-transport.js';

/** Read length-prefixed frames off a socket, calling `onFrame` per complete frame. */
function frameStream(socket: TLSSocket, onFrame: (frame: Buffer) => void, onOversized: () => void): void {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        onOversized();
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + len) return;
      onFrame(buffer.subarray(4, 4 + len));
      buffer = buffer.subarray(4 + len);
    }
  });
  socket.on('error', () => socket.destroy());
}

/** A listening peer node over TLS — identical envelope semantics to `TcpPeerNode`,
 *  with wire confidentiality. `tlsOptions` carries the deployer's key/cert (and,
 *  for mutual auth, `ca` + `requestCert: true` + `rejectUnauthorized: true`). */
export class TlsPeerNode {
  private readonly server: Server;
  private readonly replay = new ReplayGuard();
  private port = 0;

  constructor(private readonly opts: TcpNodeOptions, tlsOptions: TlsOptions) {
    this.server = createServer(tlsOptions, (socket) => this.wire(socket as TLSSocket));
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr !== null ? addr.port : port;
    return this.port;
  }

  get listeningPort(): number {
    return this.port;
  }

  private wire(socket: TLSSocket): void {
    frameStream(socket, (frame) => this.handle(frame), () => this.opts.onReject?.('oversized', {}));
  }

  private handle(frame: Buffer): void {
    let raw: unknown;
    try {
      raw = JSON.parse(frame.toString('utf-8'));
    } catch {
      this.opts.onReject?.('bad-shape', {});
      return;
    }
    const reason = verifyEnvelope(raw, {
      selfPeerId: this.opts.identity.peerId,
      trustedPeers: this.opts.trustedPeers,
      replay: this.replay,
      ...(this.opts.clockSkewMs !== undefined ? { clockSkewMs: this.opts.clockSkewMs } : {}),
    });
    if (reason !== null) {
      const e = raw as Partial<Envelope>;
      this.opts.onReject?.(reason, {
        ...(typeof e?.eventId === 'string' ? { eventId: e.eventId } : {}),
        ...(typeof e?.senderPeer === 'string' ? { senderPeer: e.senderPeer } : {}),
      });
      return;
    }
    this.opts.onEnvelope(raw as Envelope);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Send one framed envelope to a TLS peer node (connect–send–close). `tlsOptions`
 *  carries the client cert (for mutual auth) and `ca` to pin the server. */
export function tlsSendEnvelope(host: string, port: number, envelope: Envelope, tlsOptions: ConnectionOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let framed: Buffer;
    try {
      framed = frameOf(envelope);
    } catch (e) {
      reject(e);
      return;
    }
    const socket = connect({ host, port, ...tlsOptions }, () => {
      socket.end(framed, () => resolve());
    });
    socket.on('error', reject);
  });
}

/** A persistent TLS connection to one peer — the streaming path (one handshake,
 *  then back-to-back framed envelopes over the encrypted socket). */
export class TlsConnection {
  private socket: TLSSocket | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly tlsOptions: ConnectionOptions = {},
  ) {}

  private async open(): Promise<TLSSocket> {
    if (this.socket !== null && !this.socket.destroyed) return this.socket;
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = connect({ host: this.host, port: this.port, ...this.tlsOptions }, () => resolve(s));
      s.setNoDelay(true);
      s.on('error', reject);
    });
    return this.socket;
  }

  async send(envelope: Envelope): Promise<void> {
    const socket = await this.open();
    const framed = frameOf(envelope);
    await new Promise<void>((resolve, reject) => {
      socket.write(framed, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}
