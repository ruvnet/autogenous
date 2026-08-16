//! Capability scoring + weight normalization for the gate.
//! Pure, deterministic, dependency-free.

/** Cosine similarity in [-1, 1]. Returns 0 for a zero vector or length mismatch. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Numerically-stable softmax over `scores` at temperature `tau` (> 0). */
export function softmax(scores: readonly number[], tau = 1): number[] {
  if (scores.length === 0) return [];
  const t = tau > 0 ? tau : 1;
  let max = -Infinity;
  for (const s of scores) if (s > max) max = s;
  const exps = scores.map((s) => Math.exp((s - max) / t));
  const sum = exps.reduce((acc, e) => acc + e, 0);
  if (sum === 0) return scores.map(() => 1 / scores.length);
  return exps.map((e) => e / sum);
}
