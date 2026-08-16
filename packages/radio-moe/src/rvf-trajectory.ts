import { createHash } from 'node:crypto';
import { type AgentFrame, canonicalBytes } from './agent-frame.js';

export interface TrajectoryEntry {
  index: number;
  frameHash: string;
  chain: string;
}

export interface PackagedTrajectory {
  requestId: string;
  entries: TrajectoryEntry[];
  root: string;
  rvfAvailable: boolean;
}

let rvfAvailable = false;
try {
  const rvfSpecifier: string = '@ruvector/rvf';
  await import(rvfSpecifier);
  rvfAvailable = true;
} catch {
  // The hash-chain JSON package is the always-present fallback.
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function packageTrajectory(
  requestId: string,
  frames: AgentFrame[],
): PackagedTrajectory {
  let previous = '';
  const entries = frames.map((frame, index): TrajectoryEntry => {
    const frameHash = sha256(canonicalBytes(frame));
    const chain = sha256(previous + frameHash);
    previous = chain;
    return { index, frameHash, chain };
  });

  return { requestId, entries, root: previous, rvfAvailable };
}

export function verifyTrajectory(
  packaged: PackagedTrajectory,
  frames: AgentFrame[],
): boolean {
  if (packaged.entries.length !== frames.length) return false;

  try {
    let previous = '';
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const entry = packaged.entries[index];
      if (frame === undefined || entry === undefined || entry.index !== index) return false;

      const frameHash = sha256(canonicalBytes(frame));
      const chain = sha256(previous + frameHash);
      if (entry.frameHash !== frameHash || entry.chain !== chain) return false;
      previous = chain;
    }
    return packaged.root === previous;
  } catch {
    return false;
  }
}
