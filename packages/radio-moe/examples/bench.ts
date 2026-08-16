//! Benchmark the hot path (ADR-399): frame signing, verification, trajectory
//! packaging + verification, and the end-to-end fold loop. Run: `npm run bench`.

import { PeerIdentity } from '../src/transport.js';
import { signFrame, verifyFrame, type AgentFrame } from '../src/agent-frame.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';
import {
  CommandStreamingExpert,
  endlessMixLoop,
  type EventParser,
} from '../src/streaming-experts.js';
import { BatchSigner, verifyBatch, type BatchSeal } from '../src/batch-signing.js';
import { TcpPeerNode, TcpConnection, sealEnvelope, sendEnvelope } from '../src/tcp-transport.js';

const N = Number(process.env.BENCH_N ?? 1000);
const id = PeerIdentity.generate();
const key = id.publicKeyDer.toString('hex');

function mkFrame(step: number): Omit<AgentFrame, 'signature'> {
  return {
    requestId: 'bench',
    agentId: 'bench-agent',
    step,
    kind: 'claim',
    value: `token-${step} of a realistic streamed delta with some payload text`,
    confidence: 0.5,
    uncertainty: 0.5,
    dependencies: [],
    capabilityUsed: 'reasoning',
    evidenceHashes: [],
    cost: 0,
  };
}

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

// 1. sign
let t = performance.now();
const frames: AgentFrame[] = [];
for (let i = 0; i < N; i++) frames.push(signFrame(id, mkFrame(i)));
const signMs = performance.now() - t;

// 2. verify
t = performance.now();
let ok = 0;
for (const f of frames) if (verifyFrame(f, key)) ok++;
const verifyMs = performance.now() - t;
if (ok !== N) throw new Error('verification failed during bench');

// 3. package + verify trajectory
t = performance.now();
const pkg = packageTrajectory('bench', frames);
const packageMs = performance.now() - t;
t = performance.now();
if (!verifyTrajectory(pkg, frames)) throw new Error('trajectory verify failed');
const chainVerifyMs = performance.now() - t;

// 4. end-to-end fold loop (subprocess stream → parse → sign → fold), 3 experts
const parser: EventParser = (e) => {
  const o = e as Record<string, unknown>;
  return typeof o.delta === 'string' ? [{ kind: 'claim', value: o.delta }] : [];
};
const per = Math.max(1, Math.floor(N / 3));
const mk = (name: string): CommandStreamingExpert => {
  const script = `for(let i=0;i<${per};i++) console.log(JSON.stringify({delta:"w"+i}));`;
  return new CommandStreamingExpert(name, id, [1], { command: process.execPath, args: ['-e', script] }, parser);
};
t = performance.now();
let folded = 0;
await endlessMixLoop([mk('a'), mk('b'), mk('c')], 'q', 'bench-e2e', () => folded++);
const e2eMs = performance.now() - t;

console.log(`radio-moe bench (N=${N}, ed25519 via node:crypto)`);
console.log(`  sign            ${signMs.toFixed(1).padStart(8)} ms  → ${fmt(N / (signMs / 1000))} frames/s`);
console.log(`  verify          ${verifyMs.toFixed(1).padStart(8)} ms  → ${fmt(N / (verifyMs / 1000))} frames/s`);
console.log(`  package chain   ${packageMs.toFixed(1).padStart(8)} ms  → ${fmt(N / (packageMs / 1000))} frames/s`);
console.log(`  verify chain    ${chainVerifyMs.toFixed(1).padStart(8)} ms  → ${fmt(N / (chainVerifyMs / 1000))} frames/s`);
console.log(`  e2e fold loop   ${e2eMs.toFixed(1).padStart(8)} ms  → ${fmt(folded / (e2eMs / 1000))} frames/s (${folded} frames, 3 subprocess experts)`);

// 5. ADR-396 batch profile vs per-frame verification (the optimization target).
{
  const signer = new BatchSigner(id, 'bench', 'bench-agent', 64);
  const seals: BatchSeal[] = [];
  t = performance.now();
  for (const f of frames) {
    const s = signer.push(f);
    if (s) seals.push(s);
  }
  const tail = signer.flush();
  if (tail) seals.push(tail);
  const batchSignMs = performance.now() - t;
  t = performance.now();
  let off = 0;
  let allOk = true;
  for (const s of seals) {
    allOk = verifyBatch(s, frames.slice(off, off + s.count), key) && allOk;
    off += s.count;
  }
  const batchVerifyMs = performance.now() - t;
  if (!allOk) throw new Error('batch verification failed');
  console.log(`  batch sign (64) ${batchSignMs.toFixed(1).padStart(8)} ms  → ${fmt(N / (batchSignMs / 1000))} frames/s (${seals.length} sigs vs ${N})`);
  console.log(`  batch verify    ${batchVerifyMs.toFixed(1).padStart(8)} ms  → ${fmt(N / (batchVerifyMs / 1000))} frames/s (${(verifyMs / batchVerifyMs).toFixed(1)}x vs per-frame)`);
}

// 6. TCP: connect-per-envelope vs one persistent connection (loopback).
{
  const origin = id;
  const receiver = (await import('../src/transport.js')).PeerIdentity.generate();
  let got = 0;
  const node = new TcpPeerNode({
    identity: receiver,
    trustedPeers: { [origin.peerId]: origin.publicKeyDer.toString('hex') },
    onEnvelope: () => { got += 1; },
  });
  const port = await node.listen(0);
  const M = 200;
  const mkEnv = (i: number) => sealEnvelope(origin, {
    recipientPeer: receiver.peerId, requestId: 'bench-tcp', routeEpoch: 1,
    senderSequence: i, kind: 'stream.delta', payload: { i },
  });
  const drain = async (target: number) => {
    const t0 = Date.now();
    while (got < target && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 5));
  };
  t = performance.now();
  for (let i = 1; i <= M; i++) await sendEnvelope('127.0.0.1', port, mkEnv(i));
  await drain(M);
  const perConnMs = performance.now() - t;
  const conn = new TcpConnection('127.0.0.1', port);
  t = performance.now();
  for (let i = M + 1; i <= 2 * M; i++) await conn.send(mkEnv(i));
  await drain(2 * M);
  const persistentMs = performance.now() - t;
  conn.close();
  await node.close();
  console.log(`  tcp per-conn    ${perConnMs.toFixed(1).padStart(8)} ms  → ${fmt(M / (perConnMs / 1000))} env/s`);
  console.log(`  tcp persistent  ${persistentMs.toFixed(1).padStart(8)} ms  → ${fmt(M / (persistentMs / 1000))} env/s (${(perConnMs / persistentMs).toFixed(1)}x)`);
}
