//! One flywheel turn of the self-evolving mesh (perpetual: /loop runs this
//! every tick; the champion + signed ledger persist under .harness/, mirroring
//! kimi-k3-harness's flywheel layout). Run: npm run evolve
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PeerIdentity } from '../src/transport.js';
import { evolveMesh, evaluate, verifyLedger, type EvolvableParams } from '../src/mesh-evolve.js';
import { DEFAULT_INDEPENDENCE_WEIGHTS } from '../src/lineage-independence.js';

const DIR = '.harness/mesh-flywheel';
mkdirSync(DIR, { recursive: true });
const statePath = `${DIR}/champion.json`;
const seed = Number(process.env.EVOLVE_SEED ?? 42);
const generations = Number(process.env.EVOLVE_GENERATIONS ?? 30);

const start: EvolvableParams = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, 'utf-8')).champion as EvolvableParams)
  : { weights: { ...DEFAULT_INDEPENDENCE_WEIGHTS }, quorumThreshold: 2.0 };

const id = PeerIdentity.generate();
const before = evaluate(start);
const r = evolveMesh(id, seed, generations, 4, start);

console.log(`mesh-flywheel: seed=${seed} generations=${generations} promotions=${r.promotions}`);
console.log(`  separation: ${before.separation.toFixed(4)} → ${r.fitness.separation.toFixed(4)} (${((r.fitness.separation / before.separation - 1) * 100).toFixed(1)}%)`);
console.log(`  familyStack=${r.fitness.familyStack.toFixed(3)} (< 2 required) · diversePair=${r.fitness.diversePair.toFixed(3)} (>= 1.7)`);
console.log(`  quorumThreshold=${r.champion.quorumThreshold.toFixed(3)} · weights=${JSON.stringify(r.champion.weights, (k, v) => typeof v === 'number' ? Number(v.toFixed(3)) : v)}`);
console.log(`  hard gates: ${r.fitness.hardGatesPass ? 'ALL PASS' : 'FAIL'} · ledger verifies: ${verifyLedger(r, id.publicKeyDer.toString('hex'))} · root=${r.ledger.root.slice(0, 16)}…`);

writeFileSync(statePath, JSON.stringify({ champion: r.champion, fitness: r.fitness, seed, generations, at: new Date().toISOString() }, null, 2));
writeFileSync(`${DIR}/ledger.json`, JSON.stringify({ ledger: r.ledger, history: r.history }, null, 2));
console.log(`  persisted → ${statePath}`);
