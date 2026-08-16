//! HOW-TO: define your OWN custom harness pod and run it as a streaming mesh.
//!
//! This is the template to copy: three inline role definitions (no
//! create-agent-harness checkout needed), decorrelated evidence feeds, signed
//! frames, live mixture weights, and an RVF witness trajectory — in ~80 lines.
//!
//!   npm run example:custom                     # offline (deterministic)
//!   OPENROUTER_API_KEY=... npm run example:custom   # live heterogeneous models
//!
//! To adapt: change ROLES (name/tier/systemPrompt/model), change the QUESTION,
//! feed real evidence into partitionEvidence.

import { PeerIdentity } from '../src/transport.js';
import { harnessPodExperts, type HarnessAgentDef } from '../src/harness-experts.js';
import { endlessMixLoop, type SpawnSpec } from '../src/streaming-experts.js';
import { openRouterExpert } from '../src/http-experts.js';
import { partitionEvidence, type EvidenceRef } from '../src/evidence-feeds.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';
import { RelevanceScorer } from '../src/relevance.js';
import type { AgentFrame } from '../src/agent-frame.js';

// 1 — Define your pod: any roles, any prompts, any tiers.
const ROLES: (HarnessAgentDef & { model: string })[] = [
  { name: 'skeptic', tier: 'opus', model: 'x-ai/grok-4.6',
    systemPrompt: 'You are the skeptic. Find the strongest objection to the proposal. <=60 words.' },
  { name: 'builder', tier: 'sonnet', model: 'google/gemini-3.7-flash',
    systemPrompt: 'You are the builder. Give the smallest concrete implementation step. <=60 words.' },
  { name: 'auditor', tier: 'sonnet', model: 'deepseek/deepseek-v4-pro-0813',
    systemPrompt: 'You are the auditor. Name what must be measured before shipping. <=60 words.' },
];

const QUESTION = 'Proposal: cache expert adverts for 60s to cut control-plane chatter.';

// 2 — Decorrelated evidence feeds (never identical context to all experts).
const POOL: EvidenceRef[] = [
  { id: 'bench-adverts', relevance: 0.9, stance: 1 },
  { id: 'stale-cache-incident', relevance: 0.8, stance: -1 },
  { id: 'gossip-cost-study', relevance: 0.7, stance: 1 },
  { id: 'revocation-latency', relevance: 0.6, stance: -1 },
  { id: 'mesh-size-forecast', relevance: 0.5, stance: 0 },
  { id: 'ttl-tuning-notes', relevance: 0.4, stance: 0 },
];
const feeds = partitionEvidence(POOL, ROLES.map((r) => r.name), 2);

// 3 — Instantiate: OpenRouter when a key is present, deterministic fake otherwise.
const live = Boolean(process.env.OPENROUTER_API_KEY);
const fakeSpawn = (def: HarnessAgentDef): SpawnSpec => ({
  command: process.execPath,
  args: ['-e', `console.log(JSON.stringify({type:'result',subtype:'success',result:${JSON.stringify(`${def.name}: examined my slice, verdict recorded.`)},total_cost_usd:0}))`],
});
const pod = live
  ? ROLES.map((r) => {
      const identity = PeerIdentity.generate();
      const feed = feeds.get(r.name)!;
      const prompt = `${r.systemPrompt}\nYour PRIVATE evidence slice (${feed.mode}): ${feed.refs.map((e) => e.id).join(', ')}.\n${QUESTION}`;
      const inner = openRouterExpert(r.name, identity, [1], { model: r.model });
      return { def: r, identity, expert: { run: (_p: string, rid: string, s?: AbortSignal) => inner.run(prompt, rid, s) } };
    })
  : harnessPodExperts(ROLES, fakeSpawn);

console.log(`custom pod (${live ? 'LIVE OpenRouter' : 'offline'}): ${pod.map((p) => p.def.name).join(', ')}`);
for (const p of pod) console.log(`  ${p.def.name.padEnd(8)} feed=${feeds.get(p.def.name)!.mode.padEnd(11)} [${feeds.get(p.def.name)!.refs.map((e) => e.id).join(', ')}]`);

// 4 — Run: fold every signed frame on arrival; score relevance live.
const scorer = new RelevanceScorer(QUESTION);
const folded: AgentFrame[] = [];
const answers = new Map<string, string>();
const n = await endlessMixLoop(pod.map((p) => p.expert), QUESTION, 'custom-1', (f) => {
  folded.push(f);
  if (f.kind === 'claim' && typeof f.value === 'string' && f.confidence >= 0.8) answers.set(f.agentId, f.value);
});

console.log(`\n── ${n} signed frames ──`);
for (const [role, text] of answers) {
  const r = scorer.score(folded.filter((f) => f.agentId === role).at(-1)!);
  console.log(`  ${role.padEnd(8)} r=${r.toFixed(2)} → ${text.trim().slice(0, 100)}`);
}

// 5 — Package the run as a tamper-evident RVF witness trajectory.
const pkg = packageTrajectory('custom-1', folded);
console.log(`\nRVF trajectory: entries=${pkg.entries.length} root=${pkg.root.slice(0, 16)}… verifies=${verifyTrajectory(pkg, folded)}`);
