//! The mesh — where the two planes meet.
//!
//! CONTROL plane  = @metaharness/radio (RadioBus + Watcher): every peer keeps a
//!   local awareness log of routing decisions and folds in teammates' discoveries
//!   passively at step boundaries. It never crosses the network.
//! DATA plane     = the ed25519-signed transport: adverts (join handshake),
//!   dispatch requests, and streamed expert frames. Every inbound wire is
//!   signature-verified; a frame that fails is dropped and counted, never mixed.
//!
//! A route computes a gate decision, dispatches the chosen experts (local ones
//! run in-process; remote ones over the transport), collects their signed frames,
//! and combines them in the correct regime — `mixLogits` for logit experts,
//! `raceTextExperts` for text experts.

import { RadioBus, Watcher, type FoldedMention } from '@metaharness/radio';
import { Gate, type GateConfig } from './gate.js';
import type { Expert } from './expert.js';
import { mixLogits, raceTextExperts, type MixedPosition, type RaceOutcome } from './merge.js';
import {
  seal,
  verifySealed,
  verifyAdmitted,
  type AdmittedPeerRegistry,
  type DataTransport,
  type PeerIdentity,
  type SignedWire,
} from './transport.js';
import type {
  Chunk,
  ExpertAdvert,
  ExpertFrame,
  ExpertKind,
  GateDecision,
  LogitFrame,
  RouteMetrics,
  TextFrame,
  Wire,
} from './types.js';

const CONTROL_THREAD = 'mora-control';

export type Merged =
  | { kind: 'logit'; positions: MixedPosition[]; tokens: number[] }
  | { kind: 'text'; outcome: RaceOutcome };

export interface RouteResult {
  decision: GateDecision;
  merged: Merged;
  metrics: RouteMetrics;
  /** Teammate discoveries folded in passively during this route (control plane). */
  discoveries: FoldedMention[];
}

interface Collector {
  frames: ExpertFrame[];
  firstAt: number | null;
  rejected: number;
}

export class Peer {
  readonly peerId: string;
  readonly gate: Gate;
  readonly radio = new RadioBus();
  private readonly watcher: Watcher;
  private readonly localExperts = new Map<string, Expert>();
  private readonly active = new Map<string, Collector>();

  constructor(
    readonly identity: PeerIdentity,
    private readonly transport: DataTransport,
    gateCfg: Partial<GateConfig> = {},
    /**
     * Optional admitted-peer allowlist (P1 #5). When provided, an inbound frame
     * must come from an ADMITTED peer, not merely a validly-signed one — a
     * well-formed frame from an un-admitted peer is dropped like a bad signature.
     * Omit for an open-membership mesh (verification stays possession-only).
     */
    private readonly admissions?: AdmittedPeerRegistry,
  ) {
    if (identity.peerId !== transport.peerId) {
      throw new Error(
        `Peer identity (${identity.peerId}) must match its transport (${transport.peerId}) — ` +
          'seal and addressing both key off the peerId.',
      );
    }
    this.peerId = identity.peerId;
    this.gate = new Gate(gateCfg);
    this.radio.createThread(CONTROL_THREAD, [this.peerId]);
    this.watcher = new Watcher(this.radio, this.peerId);
    this.transport.onWire((sealed) => this.onWire(sealed));
  }

  /** Host a local expert: register it, gossip a signed advert, note it locally. */
  host(expert: Expert): ExpertAdvert {
    const advert = this.advertFor(expert);
    this.localExperts.set(expert.expertId, expert);
    this.gate.register(advert);
    this.transport.send(seal(this.identity, { kind: 'advert', peerId: this.peerId, advert }));
    this.radio.send(CONTROL_THREAD, this.peerId, `advert ${expert.expertId} (${expert.kind})`, []);
    return advert;
  }

  private advertFor(expert: Expert): ExpertAdvert {
    const base: ExpertAdvert = {
      peerId: this.peerId,
      expertId: expert.expertId,
      kind: expert.kind,
      capability: expert.capability,
    };
    if (expert.kind === 'logit') {
      const le = expert as Expert & { vocabId: string; vocabSize: number };
      return { ...base, vocabId: le.vocabId, vocabSize: le.vocabSize };
    }
    return base;
  }

  private onWire(sealed: SignedWire): void {
    // Possession-only (open mesh) unless an admission allowlist is configured, in
    // which case a validly-signed but UN-admitted peer is rejected too (P1 #5).
    const accepted = this.admissions
      ? verifyAdmitted(sealed, this.admissions)
      : verifySealed(sealed);
    if (!accepted) {
      // Untrusted: we may still read the claimed chunkId to attribute the drop,
      // but we NEVER apply the payload.
      const w = sealed.wire as Partial<ExpertFrame>;
      if (w && typeof w === 'object' && 'chunkId' in w && w.chunkId) {
        const c = this.active.get(w.chunkId as string);
        if (c) c.rejected += 1;
      }
      return;
    }
    const wire = sealed.wire;
    switch (wire.kind) {
      case 'advert':
        this.gate.register(wire.advert);
        this.radio.send(CONTROL_THREAD, this.peerId, `learn ${wire.advert.expertId}`, []);
        return;
      case 'dispatch': {
        const expert = this.localExperts.get(wire.expertId);
        if (!expert || expert.kind !== wire.expectKind) return;
        for (const frame of expert.run(wire.chunk, this.peerId)) {
          this.transport.send(seal(this.identity, frame as Wire), wire.peerId);
        }
        return;
      }
      case 'logit':
      case 'text':
        this.collect(wire);
        return;
    }
  }

  private collect(frame: ExpertFrame): void {
    const c = this.active.get(frame.chunkId);
    if (!c) return;
    if (c.firstAt === null) c.firstAt = performance.now();
    c.frames.push(frame);
  }

  /**
   * Route one chunk to the top-k experts of `kind` and combine their streamed
   * output in the correct regime. Synchronous against the in-memory fabric
   * (frames arrive during dispatch); a live async transport uses `routeAsync`
   * (documented in the ADR) with the same body around an await barrier.
   */
  route(chunk: Chunk, kind: ExpertKind): RouteResult {
    const t0 = performance.now();
    const decision = this.gate.route(chunk, kind);
    const routingMs = performance.now() - t0;

    const before = this.radio.messageCount;
    this.radio.send(
      CONTROL_THREAD,
      this.peerId,
      `route ${decision.chunkId} -> ${decision.routed.map((r) => r.expertId).join(',')}`,
      decision.routed.map((r) => r.peerId),
    );
    const discoveries = this.watcher.fold();

    const collector: Collector = { frames: [], firstAt: null, rejected: 0 };
    this.active.set(decision.chunkId, collector);
    const dispatchStart = performance.now();

    for (const r of decision.routed) {
      if (r.peerId === this.peerId) {
        const expert = this.localExperts.get(r.expertId);
        if (expert) for (const f of expert.run(chunk, this.peerId)) this.collect(f);
      } else {
        this.transport.send(
          seal(this.identity, {
            kind: 'dispatch',
            peerId: this.peerId,
            chunkId: decision.chunkId,
            chunk,
            expertId: r.expertId,
            expectKind: kind,
          }),
          r.peerId,
        );
      }
    }

    const timeToFirstFrameMs = (collector.firstAt ?? dispatchStart) - dispatchStart;
    const merged = this.combine(decision, collector.frames);
    this.active.delete(decision.chunkId);

    const metrics: RouteMetrics = {
      routingMs,
      timeToFirstFrameMs,
      totalMs: performance.now() - t0,
      controlMessages: this.radio.messageCount - before,
      dataFrames: collector.frames.length,
      rejectedFrames: collector.rejected,
    };
    return { decision, merged, metrics, discoveries };
  }

  private combine(decision: GateDecision, frames: ExpertFrame[]): Merged {
    const weights = new Map(decision.routed.map((r) => [r.expertId, r.weight]));
    if (decision.kind === 'logit') {
      const logit = frames.filter((f): f is LogitFrame => f.kind === 'logit');
      const byPos = new Map<number, LogitFrame[]>();
      for (const f of logit) {
        const arr = byPos.get(f.position) ?? [];
        arr.push(f);
        byPos.set(f.position, arr);
      }
      const positions = [...byPos.keys()].sort((a, b) => a - b).map((p) => mixLogits(byPos.get(p)!, weights));
      return { kind: 'logit', positions, tokens: positions.map((p) => p.argmax) };
    }
    const finals = frames.filter((f): f is TextFrame => f.kind === 'text' && f.final);
    return { kind: 'text', outcome: raceTextExperts(decision.routed, finals) };
  }

  /** Passive awareness snapshot for diagnostics — the local control log. */
  controlLog(): string[] {
    return this.radio.snapshot(CONTROL_THREAD).map((m) => `${m.seq}:${m.sender} ${m.content}`);
  }
}

/** Assemble a set of peers over one signed fabric and cross-share their adverts.
 *  A convenience for local demos/tests; production peers join by exchanging
 *  adverts over the live transport (the `advert` wire) as they connect. */
export class Mesh {
  constructor(readonly peers: Peer[]) {}

  /** Register `expert` on `peer`; its advert propagates over the signed fabric. */
  static hostAll(assignments: { peer: Peer; expert: Expert }[]): void {
    for (const { peer, expert } of assignments) peer.host(expert);
  }
}
