import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signFrame, type AgentFrame } from '../src/agent-frame.js';
import { packageTrajectory, verifyTrajectory } from '../src/rvf-trajectory.js';
import { PeerIdentity } from '../src/transport.js';

test('packages and verifies a signed frame trajectory, rejecting tampering', () => {
  const identity = PeerIdentity.generate();
  const frames = Array.from({ length: 3 }, (_, step) =>
    signFrame(identity, {
      requestId: 'request-1',
      agentId: identity.peerId,
      step,
      kind: 'claim',
      value: `value-${step}`,
      confidence: 0.8,
      uncertainty: 0.2,
      dependencies: [],
      capabilityUsed: 'reasoning',
      evidenceHashes: [],
      cost: 0,
    }),
  );

  const packaged = packageTrajectory('request-1', frames);
  assert.equal(packaged.entries.length, 3);
  assert.equal(verifyTrajectory(packaged, frames), true);

  const tampered: AgentFrame[] = frames.map((frame, index) =>
    index === 1 ? { ...frame, value: 'tampered' } : frame,
  );
  assert.equal(verifyTrajectory(packaged, tampered), false);
});
