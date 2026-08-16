//! A local MoRA demo: a 3-peer mesh over the in-memory signed fabric.
//! Run: `npm run demo`
//!
//! Shows both regimes on the same mesh:
//!   1. logit experts sharing a vocab → a REAL mixture (Σ wᵢ·logitsᵢ)
//!   2. heterogeneous text experts → a race (ensemble), with the winner chosen
//!      by gate weight.
//! Every data frame crosses an ed25519-signed transport; routing decisions and
//! folds live on the AgentRadio control plane.

import { Fabric, InMemorySignedTransport, PeerIdentity } from '../src/transport.js';
import { Peer } from '../src/mesh.js';
import { LogitExpert, TextExpert } from '../src/expert.js';
import type { Chunk } from '../src/types.js';

const VOCAB = 'demo-vocab';
const SIZE = 6;
const peak = (i: number, scale = 4): number[] =>
  Array.from({ length: SIZE }, (_, k) => (k === i ? scale : Math.random() * 0.1));

const fabric = new Fabric();
const peer = (): Peer => {
  const id = PeerIdentity.generate();
  return new Peer(id, new InMemorySignedTransport(id, fabric), { topK: 3, tau: 0.5 });
};
const [a, b, c] = [peer(), peer(), peer()];

// Three logit experts (shared tokenizer) hosted on three peers.
a.host(new LogitExpert('grammar', [1, 0.2, 0, 0, 0, 0], VOCAB, SIZE, () => peak(0)));
b.host(new LogitExpert('facts', [0.2, 1, 0, 0, 0, 0], VOCAB, SIZE, () => peak(1)));
c.host(new LogitExpert('style', [0, 0.3, 1, 0, 0, 0], VOCAB, SIZE, () => peak(2)));

// Two text experts (heterogeneous) — a race, not a mixture.
a.host(new TextExpert('concise', [1, 0, 0, 0, 0, 0], (ch) => `Concise: ${ch.text}`));
b.host(new TextExpert('detailed', [0.1, 1, 0, 0, 0, 0], (ch) => `Detailed take on: ${ch.text}`));

console.log(`mesh: ${[a, b, c].map((p) => p.peerId).join(', ')}\n`);

const logitChunk: Chunk = { streamId: 'demo', seq: 0, features: [0.9, 0.6, 0.1, 0, 0, 0] };
const r1 = a.route(logitChunk, 'logit');
console.log('── logit mixture (real MoE) ──');
console.log('  routed :', r1.decision.routed.map((r) => `${r.expertId} w=${r.weight.toFixed(2)}`).join(', '));
console.log('  mixed token id(s):', r1.merged.kind === 'logit' ? r1.merged.tokens : '—');
console.log('  metrics:', JSON.stringify(r1.metrics));

const textChunk: Chunk = { streamId: 'demo', seq: 1, features: [0.15, 0.92, 0, 0, 0, 0], text: 'the quarterly plan' };
const r2 = a.route(textChunk, 'text');
console.log('\n── text race (ensemble, NOT MoE) ──');
console.log('  routed :', r2.decision.routed.map((r) => `${r.expertId} w=${r.weight.toFixed(2)}`).join(', '));
if (r2.merged.kind === 'text') {
  console.log('  winner :', `${r2.merged.outcome.winner.expertId} → "${r2.merged.outcome.winner.text}"`);
}
console.log('  metrics:', JSON.stringify(r2.metrics));

console.log('\n── control plane (AgentRadio) on peer A ──');
for (const line of a.controlLog()) console.log('  ' + line);
