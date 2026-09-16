/** Offline replay of real repository text, not live model traffic or a quality benchmark. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RelevanceScorer } from '../src/relevance.js';
import { ReferenceRelevanceScorer } from '../test/helpers/relevance-reference.js';
import type { AgentFrame } from '../src/agent-frame.js';

const root = new URL('../../../', import.meta.url);
const docs = new URL('docs/', root);
const paths = ['README.md', ...readdirSync(docs, { recursive: true, encoding: 'utf8' }).filter(p => p.endsWith('.md')).sort().map(p => `docs/${p}`)];
const corpus = paths.map(path => ({ path, text: readFileSync(new URL(path, root), 'utf8') }));
const manifest = corpus.map(({ path, text }) => ({ path, sha256: createHash('sha256').update(text).digest('hex') }));
const prompt = 'routing authority agent mesh evidence confidence signed promotion rollback';
const chunkSize = 64;
const charsPerAgent = 8192;
const samples = 9;
let checksum = 0;

function framesFor(agents: number): AgentFrame[] {
  const frames: AgentFrame[] = [];
  for (let offset = 0; offset < charsPerAgent; offset += chunkSize) {
    for (let agent = 0; agent < agents; agent++) {
      const source = corpus[agent % corpus.length]!.text.slice(0, charsPerAgent);
      if (offset >= source.length) continue;
      frames.push({ requestId: 'bench', agentId: `peer${agent}`, step: offset / chunkSize,
        kind: 'claim', value: source.slice(offset, offset + chunkSize), confidence: 0.5,
        uncertainty: 0.5, dependencies: [], capabilityUsed: 'reasoning', evidenceHashes: [],
        cost: 0, signature: 'offline-scorer-only' });
    }
  }
  return frames;
}
function run(Ctor: typeof RelevanceScorer | typeof ReferenceRelevanceScorer, frames: AgentFrame[]): number {
  const scorer = new Ctor(prompt);
  const start = performance.now();
  for (let i = 0; i < frames.length; i++) {
    checksum += scorer.score(frames[i]!);
    if (i % 32 === 0) scorer.fold(frames[i]!.value as string);
  }
  return performance.now() - start;
}
function stats(times: number[], frames: number) {
  const sorted = [...times].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)]!;
  return { medianMs, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!, usPerFrame: medianMs * 1000 / frames, samplesMs: times };
}
const results = [];
for (const agents of [1, 4, 16]) {
  const frames = framesFor(agents);
  const reference = new ReferenceRelevanceScorer(prompt);
  const optimized = new RelevanceScorer(prompt);
  let maxError = 0;
  for (let i = 0; i < frames.length; i++) {
    maxError = Math.max(maxError, Math.abs(reference.score(frames[i]!) - optimized.score(frames[i]!)));
    if (i % 32 === 0) { reference.fold(frames[i]!.value as string); optimized.fold(frames[i]!.value as string); }
  }
  assert.ok(maxError <= 1e-12, `score mismatch: ${maxError}`);
  for (let i = 0; i < 3; i++) { run(ReferenceRelevanceScorer, frames); run(RelevanceScorer, frames); }
  const before: number[] = [], after: number[] = [];
  for (let i = 0; i < samples; i++) {
    // Alternate order to reduce warmup/thermal bias; both run on the same process.
    if (i % 2 === 0) { before.push(run(ReferenceRelevanceScorer, frames)); after.push(run(RelevanceScorer, frames)); }
    else { after.push(run(RelevanceScorer, frames)); before.push(run(ReferenceRelevanceScorer, frames)); }
  }
  const baseline = stats(before, frames.length), incremental = stats(after, frames.length);
  results.push({ agents, frames: frames.length, maxError, baseline, incremental, speedup: baseline.medianMs / incremental.medianMs });
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, platform: process.platform,
  root: fileURLToPath(root), chunkSize, charsPerAgent, samples, corpus: manifest, results, checksum }, null, 2));
