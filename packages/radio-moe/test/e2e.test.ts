//! Full end-to-end test (ADR-399): a 3-peer mesh streams concurrent experts,
//! every frame is signed and folded on arrival, the run is packaged as an RVF
//! witness trajectory, and both honest and adversarial paths are exercised —
//! all offline and deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerIdentity } from '../src/transport.js';
import { verifyFrame, type AgentFrame } from '../src/agent-frame.js';
import {
  CommandStreamingExpert,
  endlessMixLoop,
  type EventParser,
} from '../src/streaming-experts.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';

const parser: EventParser = (e) => {
  const o = e as Record<string, unknown>;
  return typeof o.delta === 'string' ? [{ kind: 'claim', value: o.delta }] : [];
};
function expert(agentId: string, id: PeerIdentity, words: string[]): CommandStreamingExpert {
  const script = `for (const e of ${JSON.stringify(words.map((w) => ({ delta: w })))}) console.log(JSON.stringify(e));`;
  return new CommandStreamingExpert(agentId, id, [1], { command: process.execPath, args: ['-e', script] }, parser);
}

test('E2E: stream → sign → fold → package → verify, with per-agent ordering', async () => {
  const ids = [PeerIdentity.generate(), PeerIdentity.generate(), PeerIdentity.generate()] as const;
  const experts = [
    expert('architect', ids[0], ['design ', 'the ', 'seams']),
    expert('security', ids[1], ['verify ', 'every ', 'frame']),
    expert('perf', ids[2], ['measure ', 'first']),
  ];

  const folded: AgentFrame[] = [];
  const n = await endlessMixLoop(experts, 'q', 'e2e-1', (f) => folded.push(f));
  assert.equal(n, 8, 'all frames from all three experts folded');

  // Every frame verifies against ITS OWN peer's key and no other.
  const keyOf = new Map([
    ['architect', ids[0].publicKeyDer.toString('hex')],
    ['security', ids[1].publicKeyDer.toString('hex')],
    ['perf', ids[2].publicKeyDer.toString('hex')],
  ]);
  for (const f of folded) {
    assert.ok(verifyFrame(f, keyOf.get(f.agentId)!), `${f.agentId}#${f.step} verifies`);
    const wrong = f.agentId === 'perf' ? keyOf.get('security')! : keyOf.get('perf')!;
    assert.equal(verifyFrame(f, wrong), false, 'cross-peer key must NOT verify');
  }

  // Per-agent step ordering is monotonic even under concurrent folding.
  for (const agent of keyOf.keys()) {
    const steps = folded.filter((f) => f.agentId === agent).map((f) => f.step);
    assert.deepEqual(steps, [...steps].sort((a, b) => a - b), `${agent} steps monotonic`);
  }

  // Package + verify the witness trajectory; any single-frame tamper breaks it.
  const pkg = packageTrajectory('e2e-1', folded);
  assert.equal(pkg.entries.length, folded.length);
  assert.ok(verifyTrajectory(pkg, folded));
  const tampered = folded.map((f, i) => (i === 3 ? { ...f, value: 'poison' } : f));
  assert.equal(verifyTrajectory(pkg, tampered), false, 'tampered frame breaks the chain');
  const reordered = [...folded.slice(1), folded[0]!];
  assert.equal(verifyTrajectory(pkg, reordered), false, 'reordering breaks the chain');
});

test('E2E: cancellation mid-stream leaves a verifiable partial trajectory', async () => {
  const id = PeerIdentity.generate();
  const slow = new CommandStreamingExpert('slow', id, [1], {
    command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({delta:"a"}));console.log(JSON.stringify({delta:"b"}));setInterval(()=>{},1e9);'],
  }, parser);
  const ac = new AbortController();
  const folded: AgentFrame[] = [];
  const loop = endlessMixLoop([slow], 'q', 'e2e-2', (f) => {
    folded.push(f);
    if (folded.length === 2) ac.abort(); // cancel once both frames arrive
  }, ac.signal);
  await loop;
  assert.equal(folded.length, 2);
  const pkg = packageTrajectory('e2e-2', folded);
  assert.ok(verifyTrajectory(pkg, folded), 'partial run still yields a valid witness chain');
});
