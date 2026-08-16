//! Decorrelated per-expert evidence feeds — implemented to the contract the
//! mesh's own implementer expert (codex, dogfood-1) designed, honoring the
//! ReM-MoA mandate: never identical context to all experts (shared context
//! accelerates diversity collapse; sharing one reference set costs −2.50 avg
//! at L=9 — docs/research/2026-08-16-streaming-mixture-sota.md finding 4).
//!
//! Contract (verbatim from the dogfood design): deduplicate pool by `id`; sort
//! experts lexicographically; require `pool.length >= expertIds.length*width`;
//! cycle modes by expert index; rank by relevance desc for `top`, asc for
//! `bottom`, alternating strongest positive/negative stance for `contrastive`;
//! break every tie by `id`; each expert takes the first `width` globally unused
//! candidates. Pure and input-order-independent → disjoint reference sets, so
//! sourceIds/evidenceHashes cannot manufacture correlated action-gate support.

export interface EvidenceRef {
  id: string;
  relevance: number;
  /** −1 opposing · 0 neutral · 1 supporting. */
  stance: -1 | 0 | 1;
}

export type FeedMode = 'top' | 'bottom' | 'contrastive';

export interface Feed {
  mode: FeedMode;
  refs: readonly EvidenceRef[];
}

const MODES: readonly FeedMode[] = ['top', 'bottom', 'contrastive'];

function byIdAsc(a: EvidenceRef, b: EvidenceRef): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Ranking per mode, ties always broken by id (deterministic). */
function ranked(pool: EvidenceRef[], mode: FeedMode): EvidenceRef[] {
  if (mode === 'top') {
    return [...pool].sort((a, b) => b.relevance - a.relevance || byIdAsc(a, b));
  }
  if (mode === 'bottom') {
    return [...pool].sort((a, b) => a.relevance - b.relevance || byIdAsc(a, b));
  }
  // contrastive: alternate strongest supporting / strongest opposing.
  const pos = pool
    .filter((r) => r.stance > 0)
    .sort((a, b) => b.relevance - a.relevance || byIdAsc(a, b));
  const neg = pool
    .filter((r) => r.stance < 0)
    .sort((a, b) => b.relevance - a.relevance || byIdAsc(a, b));
  const rest = pool
    .filter((r) => r.stance === 0)
    .sort((a, b) => b.relevance - a.relevance || byIdAsc(a, b));
  const out: EvidenceRef[] = [];
  for (let i = 0; i < Math.max(pos.length, neg.length); i++) {
    if (i < pos.length) out.push(pos[i]!);
    if (i < neg.length) out.push(neg[i]!);
  }
  return [...out, ...rest];
}

/**
 * Partition `pool` into disjoint per-expert reference sets. Deterministic given
 * (pool, expertIds, width) regardless of input order. Throws when the pool is
 * too small — reject insufficient pools instead of silently reusing evidence.
 */
export function partitionEvidence(
  pool: readonly EvidenceRef[],
  expertIds: readonly string[],
  width: number,
): ReadonlyMap<string, Feed> {
  if (width < 1) throw new Error('width must be >= 1');
  const deduped = [...new Map(pool.map((r) => [r.id, r])).values()];
  const experts = [...expertIds].sort();
  if (deduped.length < experts.length * width) {
    throw new Error(
      `insufficient evidence pool: ${deduped.length} < ${experts.length}×${width}`,
    );
  }
  const used = new Set<string>();
  const feeds = new Map<string, Feed>();
  experts.forEach((expertId, i) => {
    const mode = MODES[i % MODES.length]!;
    const refs: EvidenceRef[] = [];
    for (const candidate of ranked(deduped, mode)) {
      if (refs.length >= width) break;
      if (used.has(candidate.id)) continue;
      used.add(candidate.id);
      refs.push(candidate);
    }
    feeds.set(expertId, { mode, refs });
  });
  return feeds;
}
