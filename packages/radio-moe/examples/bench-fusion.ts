//! Fusion-vs-best-single benchmark (PIM ADR-401 V1 milestone #2; ADR-402 cond 3).
//!
//! Does the fused mixture actually make BETTER decisions than the strongest
//! single expert? The streaming-mixture research (docs/research/
//! 2026-08-16-pim-new-angles.md) is explicit that this is NOT free: agreement
//! among correlated agents is weak evidence, and naive vote-counting can score
//! *worse* than the best single model when experts share errors. So we measure,
//! three ways, on two deliberately-constructed regimes:
//!
//!   • best-single  — the accuracy of the strongest individual expert
//!   • naive-vote   — plain majority vote over expert answers (no independence)
//!   • mixture      — the real `MixtureState` fusion (ADR-397), whose
//!                    `selectIndependent` collapses same-claim support that
//!                    shares sourceIds/evidence — the built-in false-consensus guard
//!
//! Honest thesis, asserted in `test/fusion-bench.test.ts`:
//!   INDEPENDENT regime → mixture BEATS best-single (independent evidence adds up).
//!   CORRELATED regime  → naive-vote is dragged BELOW best-single by shared
//!                        wrong answers, while the mixture's independence de-dup
//!                        keeps it AT/above best-single. That delta is the whole
//!                        reason lineage/source independence is in the design.
//!
//! Corpus + deterministic expert profiles are the mesh implementer's piece
//! (`examples/fusion-corpus.ts`, produced by the codex expert in the pod).
//! This harness — the part coupled to the signed-contribution fusion API — is
//! the mixer's piece. Run: `node --import tsx examples/bench-fusion.ts`.

import { PeerIdentity } from '../src/transport.js';
import { signFrame } from '../src/agent-frame.js';
import { MixtureState, signContributionInput } from '../src/mixture.js';
import { type ModelLineage } from '../src/lineage-independence.js';
import { lineageRegistry, lineageWeightedWinner } from '../src/lineage-decision.js';
import {
  EXPERTS,
  INDEPENDENT_CORPUS,
  CORRELATED_CORPUS,
  answer,
  type Task,
} from './fusion-corpus.js';

/** One expert's stable signing identity for the run (keys don't affect scores). */
const IDENTITIES = new Map(EXPERTS.map((e) => [e.id, PeerIdentity.generate()]));
const TRUSTED: Record<string, string> = Object.fromEntries(
  EXPERTS.map((e) => [e.id, IDENTITIES.get(e.id)!.publicKeyDer.toString('hex')]),
);

/** Each expert's model lineage — what lineage-weighted fusion keys independence on. */
const LINEAGE_REGISTRY: Record<string, ModelLineage> = Object.fromEntries(
  EXPERTS.map((e) => [e.id, { provider: e.provider, arch: e.arch, sizeClass: e.sizeClass, modelId: e.id }]),
);
const RESOLVE_LINEAGE = lineageRegistry(LINEAGE_REGISTRY);

/** Deterministic tie-break so equal-weight claims resolve identically every run. */
function argmax(scores: Map<string, number>): string {
  let best = '';
  let bestScore = -Infinity;
  for (const key of [...scores.keys()].sort()) {
    const s = scores.get(key)!;
    if (s > bestScore) {
      bestScore = s;
      best = key;
    }
  }
  return best;
}

/** Plain majority vote over expert answers — the no-independence baseline. */
function naiveVoteAnswer(task: Task): string {
  const votes = new Map<string, number>();
  for (const e of EXPERTS) {
    const claim = answer(e.id, task).claimId;
    votes.set(claim, (votes.get(claim) ?? 0) + 1);
  }
  return argmax(votes);
}

/** Drive the REAL `MixtureState` once per task (each expert streams one signed
 *  support frame), then read both fused decisions off the same snapshot:
 *   • `mixture` — the coefficient fusion + sourceId de-dup (highest net weight)
 *   • `lineage` — `lineageWeightedWinner` re-resolves the winner by lineage
 *     `effectiveSupport` (the real src/lineage-decision.ts, dogfooded here). */
function fuse(task: Task): { mixture: string; lineage: string } {
  const mix = new MixtureState({
    requestId: task.id,
    trustedSigners: TRUSTED,
    topK: EXPERTS.length,
  });
  for (const e of EXPERTS) {
    const id = IDENTITIES.get(e.id)!;
    const a = answer(e.id, task);
    const frame = signFrame(id, {
      requestId: task.id,
      agentId: e.id,
      step: 0,
      kind: 'claim',
      value: a.claimId,
      confidence: a.quality,
      uncertainty: a.uncertainty,
      dependencies: [],
      capabilityUsed: 'answer',
      evidenceHashes: [],
      cost: a.cost,
    });
    const input = signContributionInput(id, frame, {
      claimId: a.claimId,
      relation: 'support',
      sourceIds: a.sourceIds,
      quality: a.quality,
      relevance: a.relevance,
      evidence: a.evidence,
      cost: a.cost,
      latency: a.latency,
      uncertainty: a.uncertainty,
    });
    const res = mix.consume(frame, input);
    if (res.status === 'rejected') {
      throw new Error(`mixture rejected ${e.id} on ${task.id}: ${res.reason}`);
    }
  }
  const snap = mix.snapshot();
  const byClaim = new Map<string, number>();
  for (const claim of snap.claims) byClaim.set(claim.claimId, claim.netWeight);
  return {
    mixture: argmax(byClaim),
    lineage: lineageWeightedWinner(snap, RESOLVE_LINEAGE).claimId ?? '',
  };
}

export interface CorpusReport {
  label: string;
  tasks: number;
  perExpert: { id: string; accuracy: number }[];
  bestSingle: number;
  naiveVote: number;
  mixture: number;
  lineageMixture: number;
  mixtureVsBest: number;
  lineageVsBest: number;
  lineageVsNaive: number;
}

const acc = (hits: number, n: number): number => (n === 0 ? 0 : hits / n);

export function runFusionBench(corpus: Task[], label: string): CorpusReport {
  const perExpert = EXPERTS.map((e) => ({
    id: e.id,
    accuracy: acc(
      corpus.filter((t) => answer(e.id, t).claimId === t.groundTruth).length,
      corpus.length,
    ),
  }));
  const bestSingle = Math.max(...perExpert.map((p) => p.accuracy));
  const naiveVote = acc(corpus.filter((t) => naiveVoteAnswer(t) === t.groundTruth).length, corpus.length);
  const fused = corpus.map((t) => ({ t, ...fuse(t) }));
  const mixture = acc(fused.filter((f) => f.mixture === f.t.groundTruth).length, corpus.length);
  const lineageMixture = acc(fused.filter((f) => f.lineage === f.t.groundTruth).length, corpus.length);
  return {
    label,
    tasks: corpus.length,
    perExpert,
    bestSingle,
    naiveVote,
    mixture,
    lineageMixture,
    mixtureVsBest: mixture - bestSingle,
    lineageVsBest: lineageMixture - bestSingle,
    lineageVsNaive: lineageMixture - naiveVote,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printReport(r: CorpusReport): void {
  console.log(`\n── ${r.label} (${r.tasks} tasks, ${EXPERTS.length} experts) ──`);
  for (const p of r.perExpert.sort((a, b) => b.accuracy - a.accuracy)) {
    console.log(`  expert ${p.id.padEnd(16)} ${pct(p.accuracy)}`);
  }
  const d = (x: number): string => `${x >= 0 ? '+' : ''}${pct(x)}`;
  console.log(`  best-single           ${pct(r.bestSingle)}`);
  console.log(`  naive-vote            ${pct(r.naiveVote)}  (Δ vs best ${d(r.naiveVote - r.bestSingle)})`);
  console.log(`  mixture (source-dedup)${pct(r.mixture).padStart(7)}  (Δ vs best ${d(r.mixtureVsBest)})`);
  console.log(`  MIXTURE + lineage     ${pct(r.lineageMixture)}  (Δ vs best ${d(r.lineageVsBest)}, Δ vs naive ${d(r.lineageVsNaive)})`);
}

// CLI entry (skipped when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const independent = runFusionBench(INDEPENDENT_CORPUS, 'INDEPENDENT errors');
  const correlated = runFusionBench(CORRELATED_CORPUS, 'CORRELATED errors');
  // Machine-readable metrics for a MetaHarness/Darwin score run (see docs/METAHARNESS.md).
  if (process.env.BENCH_JSON) {
    console.log(JSON.stringify({
      metrics: {
        independent_fused_accuracy: independent.lineageMixture,
        independent_gain_vs_best: independent.lineageVsBest,
        correlated_fused_accuracy: correlated.lineageMixture,
        correlated_gain_vs_best: correlated.lineageVsBest,
        correlated_gain_vs_naive: correlated.lineageVsNaive,
      },
      reports: { independent, correlated },
    }));
  } else {
    printReport(independent);
    printReport(correlated);
    console.log(
    `\nThesis:\n` +
      `  1. INDEPENDENT errors → fusion beats the strongest single expert ` +
      `(${independent.lineageVsBest > 0 ? 'PASS' : 'FAIL'}: +${pct(independent.lineageVsBest)}).\n` +
      `  2. CORRELATED errors → naive-vote AND source-dedup fusion are dragged BELOW best-single ` +
      `by the confidently-wrong correlated cluster ` +
      `(${correlated.mixtureVsBest <= 0 && correlated.naiveVote - correlated.bestSingle <= 0 ? 'shown' : 'not shown'}).\n` +
      `  3. CORRELATED errors → LINEAGE-weighted fusion recovers to ≥ best-single ` +
      `(${correlated.lineageVsBest >= 0 ? 'PASS' : 'FAIL'}: ${correlated.lineageVsBest >= 0 ? '+' : ''}${pct(correlated.lineageVsBest)}) ` +
      `and beats naive-vote (${correlated.lineageVsNaive > 0 ? 'PASS' : 'FAIL'}: +${pct(correlated.lineageVsNaive)}).\n` +
      `  → Independence must be measured by LINEAGE, not just shared sourceIds (ADR-401 cap 3 / false-consensus invariant).`,
    );
  }
}
