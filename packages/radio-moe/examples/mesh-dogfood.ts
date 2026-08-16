//! Dogfood (GOAP step 3): the mesh designs ITS OWN next build items.
//!
//! A 3-role pod runs as real streaming mesh experts — architect + reviewer on
//! `claude -p`, implementer on `codex exec` (heterogeneous backends = model
//! diversity, per the correlated-errors research). Each role receives a
//! DELIBERATELY DECORRELATED brief (a distinct design question in its system
//! prompt — practicing research item 1 while building it). Every frame is
//! ed25519-signed, folded on arrival, and the run is packaged as an RVF
//! witness trajectory. The folded design is written to stdout for capture.
//!
//! Run: node --import tsx examples/mesh-dogfood.ts   (≈3 short LLM calls)

import { PeerIdentity } from '../src/transport.js';
import {
  CommandStreamingExpert,
  claudeStreamParser,
  codexStreamParser,
  endlessMixLoop,
} from '../src/streaming-experts.js';
import { verifyFrame, type AgentFrame } from '../src/agent-frame.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';
import { openRouterExpert } from '../src/http-experts.js';

const CONTEXT =
  'Context: radio-moe (ruvnet/autogenous packages/radio-moe) — a streaming agent mesh: ' +
  'AgentFrame {requestId, agentId, step, kind, value, confidence, uncertainty, dependencies, ' +
  'capabilityUsed, evidenceHashes, cost, signature(ed25519 over canonical bytes)}. TCP envelopes ' +
  'carry {eventId(16B hex), senderSequence per (sender,request), issuedAt/expiresAt, kind, payload} ' +
  'with replay-window + monotonic-sequence checks. action-gate.ts: ActionSupport {agentId, principalId, ' +
  'modelId, sourceIds, signature} — independence today = distinct modelId AND disjoint sourceIds. ' +
  'Answer YOUR question only, <=150 words, concrete TypeScript-level design.';

// Preferred backends: OpenRouter heterogeneous models (spares local CLI quota);
// claude/codex CLIs remain as the no-key fallback.
const OR_MODELS: Record<string, string> = {
  architect: 'google/gemini-3.7-flash',
  implementer: 'deepseek/deepseek-v4-pro-0813',
  reviewer: 'x-ai/grok-4.6',
};

const BRIEFS: { role: string; backend: 'claude' | 'codex'; question: string }[] = [
  {
    role: 'architect',
    backend: 'claude',
    question:
      'Design in-frame replay binding: bind each AgentFrame to its stream instance so a signed frame ' +
      'replayed inside a different envelope/stream within TTL is rejected. Where does the nonce come from, ' +
      'which field carries it, who checks it, and why is it sound?',
  },
  {
    role: 'implementer',
    backend: 'codex',
    question:
      'Design decorrelated per-expert evidence feeds (ReM-MoA mandate: never identical context to all ' +
      'experts). Give a small pure function API that partitions a pool of evidence items into per-expert ' +
      'reference sets (e.g. top/bottom/contrastive slices), deterministic given (pool, expertIds).',
  },
  {
    role: 'reviewer',
    backend: 'claude',
    question:
      'Design graded lineage independence for the action gate: extend ActionSupport with provider/' +
      'architecture/sizeClass; replace the binary distinct-modelId check with a pairwise independence ' +
      'weight (ICML-2025: same provider/arch/size predict correlated errors; llama-3.2-90b vs 3.1-70b ' +
      'agree 0.97 when wrong). Also: 2-sentence sketch of a k-of-n counter-signing completion quorum. ' +
      'Note: the accuracy-correlation claim is UNVERIFIED — weights must stay tunable, not frozen.',
  },
];

function expertFor(brief: (typeof BRIEFS)[number], identity: PeerIdentity): { run(prompt: string, requestId: string, signal?: AbortSignal): AsyncGenerator<AgentFrame> } {
  const prompt = `${CONTEXT}\n\nYOUR QUESTION (${brief.role}): ${brief.question}`;
  if (process.env.OPENROUTER_API_KEY) {
    const model = OR_MODELS[brief.role] ?? 'openai/gpt-4o-mini';
    const inner = openRouterExpert(brief.role, identity, [1], { model });
    return { run: (_p, requestId, signal) => inner.run(prompt, requestId, signal) };
  }
  if (brief.backend === 'codex') {
    return new CommandStreamingExpert(brief.role, identity, [1], {
      command: 'codex',
      args: ['exec', '--json', '-s', 'read-only', prompt],
    }, codexStreamParser);
  }
  return new CommandStreamingExpert(brief.role, identity, [1], {
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', prompt],
  }, claudeStreamParser);
}

const peers = BRIEFS.map((brief) => {
  const identity = PeerIdentity.generate();
  return { brief, identity, expert: expertFor(brief, identity) };
});

console.log(`dogfood pod: ${peers.map((p) => `${p.brief.role}[${p.brief.backend}](${p.identity.peerId})`).join(', ')}\n`);

const folded: AgentFrame[] = [];
const byRole = new Map<string, string>();
const t0 = performance.now();
const n = await endlessMixLoop(
  peers.map((p) => p.expert),
  'Design your assigned mesh improvement.',
  'dogfood-1',
  (f) => {
    folded.push(f);
    // Prefer the terminal high-confidence claim per role as the design answer.
    if (f.kind === 'claim' && typeof f.value === 'string' && f.confidence >= 0.8) {
      byRole.set(f.agentId, f.value);
    }
  },
);
const ms = performance.now() - t0;

console.log(`── ${n} signed frames in ${(ms / 1000).toFixed(1)} s ──\n`);
for (const { brief, identity } of peers) {
  const design = byRole.get(brief.role);
  console.log(`### ${brief.role} [${brief.backend}] — ${design ? 'DESIGN' : 'NO FINAL FRAME (degraded)'}`);
  if (design) console.log(design.trim(), '\n');
  const roleFrames = folded.filter((f) => f.agentId === brief.role);
  const signedOk = roleFrames.every((f) => verifyFrame(f, identity.publicKeyDer.toString('hex')));
  console.log(`(frames: ${roleFrames.length}, all signed: ${signedOk})\n`);
}

const pkg = packageTrajectory('dogfood-1', folded);
console.log(`RVF trajectory: entries=${pkg.entries.length} root=${pkg.root.slice(0, 16)}… verifies=${verifyTrajectory(pkg, folded)}`);
