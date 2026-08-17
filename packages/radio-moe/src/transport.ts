//! The DATA plane: a direct, ed25519-signed peer transport for streamed expert
//! frames. Every frame is signed by its origin peer and verified on receipt; a
//! frame whose signature does not verify is dropped and counted, never applied.
//!
//! `InMemorySignedTransport` is the deterministic, offline reference used by the
//! tests and the local demo — it performs REAL signing/verification but delivers
//! in-process. A production `TrysteroTransport` (serverless WebRTC data channels)
//! implements the same interface and is documented in ADR-396; it is loaded
//! lazily so this package builds and tests with zero network dependency.

import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import type { Wire } from './types.js';

/** An ed25519 identity. The peerId is a stable fingerprint of the public key. */
export class PeerIdentity {
  readonly peerId: string;
  readonly publicKeyDer: Buffer;
  private readonly privateKey: KeyObject;

  private constructor(publicKey: KeyObject, privateKey: KeyObject) {
    this.publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    this.privateKey = privateKey;
    this.peerId = createHash('sha256').update(this.publicKeyDer).digest('hex').slice(0, 16);
  }

  static generate(): PeerIdentity {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return new PeerIdentity(publicKey, privateKey);
  }

  /** ed25519 detached signature (hex) over `bytes`. */
  sign(bytes: Buffer): string {
    return edSign(null, bytes, this.privateKey).toString('hex');
  }
}

/** Canonical bytes a frame's signature covers — stable across peers. */
export function wireBytes(wire: Wire): Buffer {
  return Buffer.from(JSON.stringify(wire));
}

/** A signed transport envelope. */
export interface SignedWire {
  wire: Wire;
  peerId: string;
  /** DER SPKI public key (hex) so any receiver can verify without prior exchange. */
  publicKeyDer: string;
  signatureHex: string;
}

/** Seal a wire message with a peer identity. */
export function seal(identity: PeerIdentity, wire: Wire): SignedWire {
  return {
    wire,
    peerId: identity.peerId,
    publicKeyDer: identity.publicKeyDer.toString('hex'),
    signatureHex: identity.sign(wireBytes(wire)),
  };
}

/** Verify a sealed frame: the signature matches the embedded key, the key's
 *  fingerprint matches the claimed peerId, and the frame's own peerId agrees. */
export function verifySealed(sealed: SignedWire): boolean {
  try {
    const der = Buffer.from(sealed.publicKeyDer, 'hex');
    const fingerprint = createHash('sha256').update(der).digest('hex').slice(0, 16);
    if (fingerprint !== sealed.peerId) return false;
    if (sealed.wire.peerId !== sealed.peerId) return false;
    const publicKey = { key: der, format: 'der', type: 'spki' } as const;
    return edVerify(null, wireBytes(sealed.wire), publicKey, Buffer.from(sealed.signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * The set of peers ADMITTED to a mesh (external review P1 #5). `verifySealed`
 * proves a frame's sender possesses the private key for the embedded public key
 * — but **possession is not admission**: anyone can generate a keypair and seal
 * well-formed frames. This registry is the allowlist of peers admitted
 * out-of-band (or by a governed process); a frame from a validly-signed but
 * UN-admitted peer is rejected, exactly like a bad signature. It binds
 * `peerId -> the exact admitted public key`, so an admitted peerId cannot be
 * impersonated by presenting a different key.
 *
 * This is the transport analogue of the outcome-verifier's `trustedVerifiers`
 * gate: a valid signature answers "who signed this?", not "may they participate?".
 */
export class AdmittedPeerRegistry {
  private readonly byId = new Map<string, string>(); // peerId -> publicKeyDer (hex)

  /**
   * Admit a peer by its id + DER SPKI public key (hex). Throws if the key's
   * fingerprint does not match the peerId — such an entry could never match a
   * validly-sealed frame (whose peerId must equal its key's fingerprint), so
   * admitting it is a caller error, not a silent no-op.
   */
  admit(peerId: string, publicKeyDerHex: string): void {
    const fingerprint = createHash('sha256')
      .update(Buffer.from(publicKeyDerHex, 'hex'))
      .digest('hex')
      .slice(0, 16);
    if (fingerprint !== peerId) {
      throw new Error(
        `refusing to admit peer ${peerId}: its public key fingerprints to ${fingerprint}`,
      );
    }
    this.byId.set(peerId, publicKeyDerHex);
  }

  /** Admit a known identity directly (its id + public key are self-consistent). */
  admitIdentity(identity: PeerIdentity): void {
    this.admit(identity.peerId, identity.publicKeyDer.toString('hex'));
  }

  /** Remove a peer's admission (e.g. on revocation). Idempotent. */
  revoke(peerId: string): void {
    this.byId.delete(peerId);
  }

  /** Is `(peerId, key)` an admitted pair? Requires the EXACT admitted key. */
  isAdmitted(peerId: string, publicKeyDerHex: string): boolean {
    const known = this.byId.get(peerId);
    return known !== undefined && known === publicKeyDerHex;
  }

  admittedIds(): string[] {
    return [...this.byId.keys()];
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * Admission-gated verification (P1 #5): a frame is accepted only if it is
 * validly sealed AND comes from an ADMITTED peer presenting its admitted key.
 * Possession alone is not enough. Use this at the receive boundary in place of
 * bare `verifySealed` whenever the mesh is not open-membership.
 */
export function verifyAdmitted(sealed: SignedWire, admissions: AdmittedPeerRegistry): boolean {
  if (!verifySealed(sealed)) return false;
  return admissions.isAdmitted(sealed.peerId, sealed.publicKeyDer);
}

export type WireHandler = (sealed: SignedWire) => void;

/** The transport seam. Implementations carry SIGNED frames between peers. */
export interface DataTransport {
  readonly peerId: string;
  /** Send a sealed frame to a specific peer (or broadcast when `to` is omitted). */
  send(sealed: SignedWire, to?: string): void;
  /** Subscribe to inbound sealed wire messages. */
  onWire(handler: WireHandler): void;
  /** Peers currently reachable. */
  peers(): string[];
  leave(): void;
}

/**
 * Deterministic, offline reference transport: a single in-process switchboard
 * that connects every transport constructed against the same `Fabric`. Real
 * signing/verification; no network. This is the test/demo analogue of a live
 * WebRTC mesh.
 */
export class Fabric {
  private readonly nodes = new Map<string, InMemorySignedTransport>();

  attach(t: InMemorySignedTransport): void {
    this.nodes.set(t.peerId, t);
  }

  detach(peerId: string): void {
    this.nodes.delete(peerId);
  }

  peerIds(): string[] {
    return [...this.nodes.keys()];
  }

  /** Deliver a sealed wire; verification happens at the receiving handler. */
  deliver(sealed: SignedWire, from: string, to?: string): void {
    for (const [id, node] of this.nodes) {
      if (id === from) continue;
      if (to && id !== to) continue;
      node.receive(sealed);
    }
  }
}

export class InMemorySignedTransport implements DataTransport {
  readonly peerId: string;
  private readonly handlers: WireHandler[] = [];

  constructor(
    readonly identity: PeerIdentity,
    private readonly fabric: Fabric,
  ) {
    this.peerId = identity.peerId;
    fabric.attach(this);
  }

  send(sealed: SignedWire, to?: string): void {
    this.fabric.deliver(sealed, this.peerId, to);
  }

  /** Called by the fabric on inbound wire — handlers verify before applying. */
  receive(sealed: SignedWire): void {
    for (const h of this.handlers) h(sealed);
  }

  onWire(handler: WireHandler): void {
    this.handlers.push(handler);
  }

  peers(): string[] {
    return this.fabric.peerIds().filter((p) => p !== this.peerId);
  }

  leave(): void {
    this.fabric.detach(this.peerId);
  }
}
