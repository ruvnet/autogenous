# evaluator — replay a detector over corpora with honest uncertainty (Rust)

`evaluator` is the measurement stage of [Autogenous](../), a self-evolving
AI-defense runtime in Rust. It replays a candidate [`antibody`](../antibody)
detector over **labeled corpora** (malicious + benign) and produces a
`ReplayReport`: attack **recall**, benign **false-positive rate**, and — crucially —
**Wilson-interval uncertainty** for both.

Every estimate carries its confidence interval and its evidence population, so no
downstream gate ever treats a number measured on 20 samples the same as one
measured on 20,000.

> Keywords: detector evaluation, recall/false-positive measurement, Wilson score
> interval, statistical uncertainty, benchmark harness, AI evaluation, Rust.

## What's inside

- **`replay_packaged(detector, corpus)`** — run the *serialized* detector that
  ships in an antibody (the exact artifact, not an ad-hoc closure).
- **`replay(fn, corpus)`** — run any predicate over a corpus.
- **`ReplayReport`** — recall, fp-rate, sample counts, and `to_fitness(...)` to
  turn results into an [`agl-types`](../agl-types) `FitnessVector`.
- **`wilson95(successes, n)`** — the confidence interval helper.

## Why it's pure and separate

The evaluator holds **no state** and **cannot be captured by the generator**
(ADR-392 §11): detector in, corpora in, report out. Hidden or rotating corpora are
the *caller's* responsibility — judges own the corpus, generators never see it.

## Example

```rust
use evaluator::{replay_packaged, Corpus};

let report = replay_packaged(&candidate.detector, &labeled_corpus);
println!("recall {:.3}  fp {:.3}", report.recall, report.fp_rate);
let fitness = report.to_fitness(/* p99_overhead_ms */ 1.5, /* rollback_verified */ true);
```

## Where it fits

Scores candidates from [`generator`](../generator); its fitness feeds
[`verifier`](../verifier) and the signed receipts in [`envelope`](../envelope).

## License

MIT — see [LICENSE](../../LICENSE). Design: ADR-392 Phase 5 in [`docs/adr/`](../../docs/adr).
