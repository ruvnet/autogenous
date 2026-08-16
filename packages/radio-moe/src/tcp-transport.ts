//! Direct signed TCP peer transport — the ADR-395/396 reference adapter.
//!
//! Integrity + identity only, NOT confidentiality: use on loopback, a private
//! network, or inside an encrypted tunnel; production requires QUIC + mutual
//! TLS or equivalent (ADR-396 "remaining production work").
//!
//! Envelope (ADR-396): every message commits to version · event_id · sender ·
//! recipient · request_id · route_epoch · sender_sequence · issued_at ·
//! expires_at · kind · payload, signed over the canonical (key-sorted,
//! prototype-rejecting) bytes of everything except the signature.
//!
//! Receiver verification ORDER (ADR-396, cheap before expensive): shape and
//! size → recipient → time (skew + expiry) → configured sender key → signature
//! → replay id → monotonic sequence. Rejections carry a metadata-only reason —
//! never payload content.
//!
//! Framing: 4-byte big-endian length prefix, hard MAX_FRAME_BYTES bound —
//! an oversized frame drops the connection before allocation.

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { randomBytes, verify as edVerify } from 'node:crypto';
import { canonicalBytes } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';

/** ed25519 verify against a DER SPKI public key (hex). False on any malformed input. */
function verifyHexKey(publicKeyDerHex: string, bytes: Buffer, signatureHex: string): boolean {
  try {
    return edVerify(
      null,
      bytes,
      { key: Buffer.from(publicKeyDerHex, 'hex'), format: 'der', type: 'spki' },
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_CLOCK_SKEW_MS = 5_000;
const DEFAULT_TTL_MS = 30_000;
const REPLAY_WINDOW = 4_096;

export type EnvelopeKind =
  | 'request.open'
  | 'request.cancel'
  | 'stream.delta'
  | 'stream.end'
  | 'stream.error';

export interface Envelope {
  version: number;
  eventId: string;
  senderPeer: string;
  recipientPeer: string;
  requestId: string;
  routeEpoch: number;
  senderSequence: number;
  issuedAt: number;
  expiresAt: number;
  kind: EnvelopeKind;
  payload: unknown;
  signature: string;
}

export type RejectReason =
  | 'bad-shape'
  | 'oversized'
  | 'wrong-recipient'
  | 'expired-or-skewed'
  | 'unknown-sender'
  | 'bad-signature'
  | 'replayed-event'
  | 'stale-sequence';

const KINDS = new Set<EnvelopeKind>([
  'request.open',
  'request.cancel',
  'stream.delta',
  'stream.end',
  'stream.error',
]);

function envelopeSigningBytes(e: Envelope): Buffer {
  return canonicalBytes({ ...e, signature: '' });
}

/** Build + sign an envelope. `seq` must increase per (sender, request). */
export function sealEnvelope(
  identity: PeerIdentity,
  fields: Omit<Envelope, 'version' | 'eventId' | 'senderPeer' | 'issuedAt' | 'expiresAt' | 'signature'> & {
    ttlMs?: number;
  },
  now = Date.now(),
): Envelope {
  const { ttlMs, ...rest } = fields;
  const e: Envelope = {
    version: PROTOCOL_VERSION,
    eventId: randomBytes(16).toString('hex'),
    senderPeer: identity.peerId,
    issuedAt: now,
    expiresAt: now + (ttlMs ?? DEFAULT_TTL_MS),
    ...rest,
    signature: '',
  };
  e.signature = identity.sign(envelopeSigningBytes(e));
  return e;
}

/** Structural shape check — cheap, before any crypto. */
function isShaped(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    e.version === PROTOCOL_VERSION &&
    typeof e.eventId === 'string' && e.eventId.length <= 64 &&
    typeof e.senderPeer === 'string' && e.senderPeer.length <= 64 &&
    typeof e.recipientPeer === 'string' && e.recipientPeer.length <= 64 &&
    typeof e.requestId === 'string' && e.requestId.length <= 256 &&
    typeof e.routeEpoch === 'number' &&
    typeof e.senderSequence === 'number' &&
    typeof e.issuedAt === 'number' &&
    typeof e.expiresAt === 'number' &&
    typeof e.kind === 'string' && KINDS.has(e.kind as EnvelopeKind) &&
    typeof e.signature === 'string'
  );
}

/** Per-node replay + sequence state (ADR-396 invariants 3–4). */
export class ReplayGuard {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly lastSeq = new Map<string, number>();

  /** Returns null when fresh; a reason when the envelope must be rejected. */
  check(e: Envelope): RejectReason | null {
    if (this.seen.has(e.eventId)) return 'replayed-event';
    const key = `${e.senderPeer}:${e.requestId}`;
    const last = this.lastSeq.get(key);
    if (last !== undefined && e.senderSequence <= last) return 'stale-sequence';
    this.seen.add(e.eventId);
    this.order.push(e.eventId);
    if (this.order.length > REPLAY_WINDOW) this.seen.delete(this.order.shift()!);
    this.lastSeq.set(key, e.senderSequence);
    return null;
  }
}

export interface VerifyContext {
  selfPeerId: string;
  /** Out-of-band configured peer keys: peerId → DER SPKI public key (hex). */
  trustedPeers: Readonly<Record<string, string>>;
  replay: ReplayGuard;
  clockSkewMs?: number;
}

/** The full ordered verification (ADR-396). Null = accept. */
export function verifyEnvelope(raw: unknown, ctx: VerifyContext, now = Date.now()): RejectReason | null {
  if (!isShaped(raw)) return 'bad-shape';
  const e = raw;
  if (e.recipientPeer !== ctx.selfPeerId) return 'wrong-recipient';
  const skew = ctx.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (e.issuedAt > now + skew || now >= e.expiresAt) return 'expired-or-skewed';
  const key = ctx.trustedPeers[e.senderPeer];
  if (key === undefined) return 'unknown-sender';
  if (!verifyHexKey(key, envelopeSigningBytes(e), e.signature)) return 'bad-signature';
  return ctx.replay.check(e);
}

export interface TcpNodeOptions {
  identity: PeerIdentity;
  trustedPeers: Readonly<Record<string, string>>;
  /** Called once per ACCEPTED envelope. */
  onEnvelope: (e: Envelope) => void;
  /** Metadata-only rejection stream (reason + ids, never payloads). */
  onReject?: (reason: RejectReason, meta: { eventId?: string; senderPeer?: string }) => void;
  clockSkewMs?: number;
}

/** A listening peer node over plain TCP with length-prefixed framing. */
export class TcpPeerNode {
  private readonly server: Server;
  private readonly replay = new ReplayGuard();
  private port = 0;

  constructor(private readonly opts: TcpNodeOptions) {
    this.server = createServer((socket) => this.wire(socket));
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

  private wire(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const len = buffer.readUInt32BE(0);
        if (len > MAX_FRAME_BYTES) {
          this.opts.onReject?.('oversized', {});
          socket.destroy();
          return;
        }
        if (buffer.length < 4 + len) return;
        const frame = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        this.handle(frame);
      }
    });
    socket.on('error', () => socket.destroy());
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

/** Length-prefix (4-byte BE) frame an envelope. Shared with the TLS transport. */
export function frameOf(envelope: Envelope): Buffer {
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf-8');
  if (bytes.length > MAX_FRAME_BYTES) {
    throw new Error(`frame exceeds MAX_FRAME_BYTES (${bytes.length})`);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([head, bytes]);
}

/** Send one framed envelope to a peer node (connect–send–close; the reference
 *  keeps connection lifecycle trivial). For streams, use [`TcpConnection`] —
 *  one socket per (peer, stream) amortizes the TCP handshake over every delta. */
export function sendEnvelope(host: string, port: number, envelope: Envelope): Promise<void> {
  return new Promise((resolve, reject) => {
    let framed: Buffer;
    try {
      framed = frameOf(envelope);
    } catch (e) {
      reject(e);
      return;
    }
    const socket = createConnection({ host, port }, () => {
      socket.end(framed, () => resolve());
    });
    socket.on('error', reject);
  });
}

/** A persistent framed connection to one peer — the streaming-optimized path:
 *  one TCP handshake, then back-to-back framed envelopes. */
export class TcpConnection {
  private socket: Socket | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  private async connect(): Promise<Socket> {
    if (this.socket !== null && !this.socket.destroyed) return this.socket;
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ host: this.host, port: this.port, noDelay: true }, () => resolve(s));
      s.on('error', reject);
    });
    return this.socket;
  }

  /** Write one framed envelope on the persistent socket (backpressure-aware). */
  async send(envelope: Envelope): Promise<void> {
    const socket = await this.connect();
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
