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
