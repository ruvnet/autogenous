//! Cross-process mesh over the signed TCP transport (ADR-394 acceptance #1:
//! "Two direct peers stream a text response end to end").
//!
//! Run each role in its OWN process (real sockets, real process isolation —
//! the local stand-in for tailnet machines):
//!
//!   node --import tsx examples/mesh-tcp.ts --role expert --name architect --dir /tmp/meshdemo
//!   node --import tsx examples/mesh-tcp.ts --role expert --name security  --dir /tmp/meshdemo
//!   node --import tsx examples/mesh-tcp.ts --role origin --experts architect,security --dir /tmp/meshdemo
//!
//! Key exchange is out-of-band by design (ADR-396: "trusted peer public keys
//! are configured out of band") — here, JSON descriptors in `--dir`. Experts
//! stream `stream.delta` envelopes whose payloads are ed25519-signed
//! AgentFrames; the origin verifies BOTH layers (envelope + frame), folds into
//! the level-2 MixtureState with relevance scoring, and packages the run as an
//! RVF witness trajectory.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PeerIdentity } from '../src/transport.js';
import { TcpPeerNode, sealEnvelope, sendEnvelope, type Envelope } from '../src/tcp-transport.js';
import { verifyFrame, type AgentFrame } from '../src/agent-frame.js';
import { CommandStreamingExpert, type EventParser } from '../src/streaming-experts.js';
import { openRouterExpert } from '../src/http-experts.js';
import { RelevanceScorer } from '../src/relevance.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';

const PROMPT = 'In one sentence: why keep routing and authority separate in an agent mesh?';

interface Descriptor {
  name: string;
  peerId: string;
  publicKeyDer: string;
  host: string;
  port: number;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function waitForDescriptor(dir: string, name: string, ms = 15_000): Promise<Descriptor> {
  const path = join(dir, `${name}.json`);
  const t0 = Date.now();
  for (;;) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as Descriptor;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${path}`);
    await sleep(100);
  }
}

const fakeParser: EventParser = (e) => {
  const o = e as Record<string, unknown>;
  return typeof o.delta === 'string' ? [{ kind: 'claim', value: o.delta }] : [];
};

async function runExpert(): Promise<void> {
  const name = arg('name');
  const dir = arg('dir');
  mkdirSync(dir, { recursive: true });
  const identity = PeerIdentity.generate();
  let seq = 0;

  const node = new TcpPeerNode({
    identity,
    trustedPeers: {}, // filled once the origin descriptor lands
    onEnvelope: () => {},
  });
  const port = await node.listen(0);
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ name, peerId: identity.peerId, publicKeyDer: identity.publicKeyDer.toString('hex'), host: '127.0.0.1', port } satisfies Descriptor),
  );

  const origin = await waitForDescriptor(dir, 'origin');
  // Re-listen with the origin pinned (reference adapter keeps config immutable).
  await node.close();
  const node2 = new TcpPeerNode({
    identity,
    trustedPeers: { [origin.peerId]: origin.publicKeyDer },
    onEnvelope: (e) => void handleOpen(e),
  });
  const port2 = await node2.listen(port).catch(() => node2.listen(0));
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ name, peerId: identity.peerId, publicKeyDer: identity.publicKeyDer.toString('hex'), host: '127.0.0.1', port: port2 } satisfies Descriptor),
  );
  console.log(`[${name}] listening :${port2} peer=${identity.peerId}`);

  async function handleOpen(e: Envelope): Promise<void> {
    if (e.kind !== 'request.open') return;
    const prompt = (e.payload as { prompt?: string }).prompt ?? '';
    console.log(`[${name}] request.open accepted from ${e.senderPeer}`);
    const live = Boolean(process.env.OPENROUTER_API_KEY);
    const expert = live
      ? openRouterExpert(name, identity, [1], { model: process.env.MESH_MODEL ?? 'openai/gpt-4o-mini' })
      : new CommandStreamingExpert(name, identity, [1], {
          command: process.execPath,
          args: ['-e', `for (const w of ${JSON.stringify([`${name}:`, ' separate', ' routing', ' from', ' authority.'])}) console.log(JSON.stringify({delta:w}));`],
        }, fakeParser);

    for await (const frame of expert.run(prompt, e.requestId)) {
      await sendEnvelope(origin.host, origin.port, sealEnvelope(identity, {
        recipientPeer: origin.peerId,
        requestId: e.requestId,
        routeEpoch: e.routeEpoch,
        senderSequence: ++seq,
        kind: 'stream.delta',
        payload: { frame },
      }));
    }
    await sendEnvelope(origin.host, origin.port, sealEnvelope(identity, {
      recipientPeer: origin.peerId,
      requestId: e.requestId,
      routeEpoch: e.routeEpoch,
      senderSequence: ++seq,
      kind: 'stream.end',
      payload: {},
    }));
    console.log(`[${name}] stream complete`);
    await node2.close();
    process.exit(0);
  }
}

async function runOrigin(): Promise<void> {
  const dir = arg('dir');
  const expertNames = arg('experts').split(',').map((s) => s.trim()).filter(Boolean);
  mkdirSync(dir, { recursive: true });
  const identity = PeerIdentity.generate();

  const experts = await Promise.all(expertNames.map((n) => waitForDescriptor(dir, n)));
  const trustedPeers = Object.fromEntries(experts.map((x) => [x.peerId, x.publicKeyDer]));
  const nameOf = new Map(experts.map((x) => [x.peerId, x.name]));
  const keyOf = new Map(experts.map((x) => [x.name, x.publicKeyDer]));

  const folded: AgentFrame[] = [];
  const done = new Set<string>();
  let badFrames = 0;
  const scorer = new RelevanceScorer(PROMPT);

  const node = new TcpPeerNode({
    identity,
    trustedPeers,
    onEnvelope: (e) => {
      if (e.kind === 'stream.end') {
        done.add(e.senderPeer);
        return;
      }
      if (e.kind !== 'stream.delta') return;
      const frame = (e.payload as { frame?: AgentFrame }).frame;
      const expertName = nameOf.get(e.senderPeer);
      // Layer 2: the AgentFrame inside must verify against the SAME peer's key.
      if (!frame || !expertName || frame.agentId !== expertName || !verifyFrame(frame, keyOf.get(expertName)!)) {
        badFrames += 1;
        return;
      }
      folded.push(frame);
    },
    onReject: (reason) => console.log(`[origin] rejected envelope: ${reason}`),
  });
  const port = await node.listen(0);
  writeFileSync(
    join(dir, 'origin.json'),
    JSON.stringify({ name: 'origin', peerId: identity.peerId, publicKeyDer: identity.publicKeyDer.toString('hex'), host: '127.0.0.1', port } satisfies Descriptor),
  );
  console.log(`[origin] listening :${port} — dispatching to ${expertNames.join(', ')}`);

  // Re-read expert descriptors (they may have re-listened after pinning us).
  await sleep(500);
  const fresh = await Promise.all(expertNames.map((n) => waitForDescriptor(dir, n)));
  const t0 = performance.now();
  let seq = 0;
  for (const x of fresh) {
    const env = sealEnvelope(identity, {
      recipientPeer: x.peerId,
      requestId: 'tcp-mesh-1',
      routeEpoch: 1,
      senderSequence: ++seq,
      kind: 'request.open',
      payload: { prompt: PROMPT },
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await sendEnvelope(x.host, x.port, env);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(300); // expert may be re-listening after pinning us
      }
    }
  }

  const deadline = Date.now() + 120_000;
  while (done.size < fresh.length && Date.now() < deadline) await sleep(50);
  const ms = performance.now() - t0;

  const byAgent = new Map<string, string>();
  for (const f of folded) {
    if (f.kind === 'claim' && typeof f.value === 'string') {
      byAgent.set(f.agentId, (byAgent.get(f.agentId) ?? '') + f.value);
    }
  }

  console.log(`\n── ${folded.length} verified frames from ${done.size}/${fresh.length} peers in ${ms.toFixed(0)} ms (bad frames: ${badFrames}) ──`);
  for (const [agent, text] of byAgent) console.log(`  ${agent.padEnd(10)} → ${text.trim().slice(0, 120)}`);

  const relevance = new Map([...byAgent.keys()].map((agent) => {
    const merged = folded.filter((f) => f.agentId === agent);
    const last = merged[merged.length - 1]!;
    return [agent, scorer.score(last)] as const;
  }));
  console.log(`\n── relevance r_i ──`);
  for (const [agent, r] of relevance) console.log(`  ${agent.padEnd(10)} r=${r.toFixed(3)}`);

  const trajectory = packageTrajectory('tcp-mesh-1', folded);
  console.log(`\n── RVF trajectory ──`);
  console.log(`  entries: ${trajectory.entries.length}  root: ${trajectory.root.slice(0, 16)}…`);
  console.log(`  trajectory verifies: ${verifyTrajectory(trajectory, folded)}`);
  await node.close();
  process.exit(0);
}

const role = arg('role');
if (role === 'expert') await runExpert();
else if (role === 'origin') await runOrigin();
else throw new Error(`unknown --role ${role}`);
