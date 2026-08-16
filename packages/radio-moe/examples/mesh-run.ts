//! Run the p2p mesh as a streaming mixture of agents (ADR-397/398/399).
//!
//!   npm run mesh                 # offline: deterministic fake streaming experts
//!   OPENROUTER_API_KEY=sk-... npm run mesh   # live: real OpenRouter models
//!
//! Three peers each host a streaming expert. `endlessMixLoop` folds every signed
//! AgentFrame the instant it arrives; the run's frames are then packaged into an
//! RVF-style witness trajectory (hash-chained, tamper-evident) and verified.
//!
//! No-key fallback (autonomous rule): when OPENROUTER_API_KEY is unset, each peer
//! falls back to a deterministic fake streaming subprocess so the mesh still runs
//! end-to-end — the code path (sign → fold → package → verify) is identical.

import { PeerIdentity } from '../src/transport.js';
import {
  CommandStreamingExpert,
  endlessMixLoop,
  type EventParser,
} from '../src/streaming-experts.js';
import { openRouterExpert } from '../src/http-experts.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';
import { verifyFrame, type AgentFrame } from '../src/agent-frame.js';

const PROMPT = 'In one sentence: why keep routing and authority separate in an agent mesh?';

// A deterministic fake streaming backend for the offline/no-key path.
const fakeParser: EventParser = (e) => {
  const o = e as Record<string, unknown>;
  return typeof o.delta === 'string' ? [{ kind: 'claim', value: o.delta }] : [];
};
function fakeExpert(agentId: string, id: PeerIdentity, words: string[]): CommandStreamingExpert {
  const events = words.map((w) => ({ delta: w }));
  const script = `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));`;
  return new CommandStreamingExpert(agentId, id, [1, 0, 0], { command: process.execPath, args: ['-e', script] }, fakeParser);
}

const live = Boolean(process.env.OPENROUTER_API_KEY);
const model = process.env.MESH_MODEL ?? 'openai/gpt-4o-mini';

const peers = ['architect', 'security', 'perf'].map((role, i) => {
  const id = PeerIdentity.generate();
  const cap = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  const expert = live
    ? openRouterExpert(role, id, cap, { model })
    : fakeExpert(role, id, [`${role}:`, ' separate', ' routing', ' from', ' authority.']);
  return { role, id, expert };
});

console.log(`mesh: ${peers.map((p) => `${p.role}(${p.id.peerId})`).join(', ')}`);
console.log(`mode: ${live ? `LIVE OpenRouter (${model})` : 'OFFLINE fake experts (no OPENROUTER_API_KEY)'}\n`);

const folded: AgentFrame[] = [];
const byAgent = new Map<string, string>();
const t0 = performance.now();

const n = await endlessMixLoop(
  peers.map((p) => p.expert),
  PROMPT,
  'mesh-run-1',
  (frame) => {
    folded.push(frame);
    if (frame.kind === 'claim' && typeof frame.value === 'string') {
      byAgent.set(frame.agentId, (byAgent.get(frame.agentId) ?? '') + frame.value);
    }
  },
);
const ms = performance.now() - t0;

console.log(`── folded ${n} signed frames in ${ms.toFixed(1)} ms ──`);
for (const [agent, text] of byAgent) console.log(`  ${agent.padEnd(10)} → ${text.trim()}`);

const keyOf = new Map(peers.map((p) => [p.role, p.id.publicKeyDer.toString('hex')]));
const allSigned = folded.every((f) => {
  const key = keyOf.get(f.agentId);
  return key !== undefined && verifyFrame(f, key);
});

// RVF: package the trajectory as a tamper-evident witness chain and verify it.
const trajectory = packageTrajectory('mesh-run-1', folded);
console.log(`\n── RVF trajectory ──`);
console.log(`  entries: ${trajectory.entries.length}  root: ${trajectory.root.slice(0, 16)}…`);
console.log(`  @ruvector/rvf present: ${trajectory.rvfAvailable}`);
console.log(`  every frame signature verifies: ${allSigned}`);
console.log(`  trajectory verifies: ${verifyTrajectory(trajectory, folded)}`);
