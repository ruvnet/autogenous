import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgentModule,
  loadHarnessAgents,
  harnessPodExperts,
  roleCapability,
} from '../src/harness-experts.js';
import { endlessMixLoop, type SpawnSpec } from '../src/streaming-experts.js';
import { verifyFrame, type AgentFrame } from '../src/agent-frame.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';

// The exact generated shape from metaharness/kimi-k3-harness src/agents/*.ts.
const ARCHITECT = `// SPDX-License-Identifier: MIT
// Architect agent — Designs the change before code is written.

export const SYSTEM_PROMPT = \`You are the architect. You hand a crisp plan to the implementer.\`;

export const NAME = 'architect';
export const TIER = 'opus' as const;
`;
const REVIEWER = `export const SYSTEM_PROMPT = \`You are the reviewer. Hunt correctness bugs in the diff.\`;
export const NAME = 'reviewer';
export const TIER = 'sonnet' as const;
`;

test('parseAgentModule extracts the generated SYSTEM_PROMPT/NAME/TIER shape', () => {
  const def = parseAgentModule(ARCHITECT);
  assert.deepEqual(def, {
    name: 'architect',
    systemPrompt: 'You are the architect. You hand a crisp plan to the implementer.',
    tier: 'opus',
  });
  assert.equal(parseAgentModule('export const NAME = "no-prompt";'), null);
});

test('loadHarnessAgents reads a harness checkout and roleCapability scales by tier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  try {
    mkdirSync(join(dir, 'src', 'agents'), { recursive: true });
    writeFileSync(join(dir, 'src', 'agents', 'architect.ts'), ARCHITECT);
    writeFileSync(join(dir, 'src', 'agents', 'reviewer.ts'), REVIEWER);
    writeFileSync(join(dir, 'src', 'agents', 'notes.md'), 'ignored');
    const defs = loadHarnessAgents(dir);
    assert.deepEqual(defs.map((d) => d.name), ['architect', 'reviewer']);
    assert.deepEqual(roleCapability(0, 2, 'opus'), [1, 0]);
    assert.deepEqual(roleCapability(1, 2, 'sonnet'), [0, 0.8]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a harness pod streams as ONE signed mixture with an RVF trajectory (offline)', async () => {
  const defs = [parseAgentModule(ARCHITECT)!, parseAgentModule(REVIEWER)!];
  // Offline backend: echo claude-style stream-json events instead of real claude -p.
  const fakeSpawn = (def: { name: string }): SpawnSpec => {
    const events = [
      { type: 'stream_event', event: { delta: { type: 'text_delta', text: `${def.name} speaking` } } },
      { type: 'result', subtype: 'success', result: `${def.name} done`, total_cost_usd: 0.001 },
    ];
    const script = `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));`;
    return { command: process.execPath, args: ['-e', script] };
  };

  const pod = harnessPodExperts(defs, fakeSpawn);
  assert.equal(pod.length, 2);

  const folded: AgentFrame[] = [];
  const n = await endlessMixLoop(pod.map((p) => p.expert), 'improve the kernel', 'harness-run-1', (f) => folded.push(f));
  assert.equal(n, 4, 'delta + result frame per agent');
  assert.ok(folded.some((f) => f.agentId === 'architect') && folded.some((f) => f.agentId === 'reviewer'));
  assert.ok(folded.every((f) => f.capabilityUsed.startsWith('harness:')));
  for (const f of folded) {
    const peer = pod.find((p) => p.def.name === f.agentId)!;
    assert.ok(verifyFrame(f, peer.identity.publicKeyDer.toString('hex')), 'signed by its own role identity');
  }
  const pkg = packageTrajectory('harness-run-1', folded);
  assert.ok(verifyTrajectory(pkg, folded), 'pod run packages as a valid RVF witness chain');
});
