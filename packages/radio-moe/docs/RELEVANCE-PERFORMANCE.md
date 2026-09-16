# Incremental streaming relevance

The public `RelevanceScorer` now maintains term counts and cached norms per
request. Previously every frame retokenized its agent's full accumulated response
and every other agent's response. The new implementation updates only the incoming
delta and the unfinished token at its boundary, then compares cached sparse bags.
It preserves the existing topicality, echo penalty, fold semantics and API.

The incomplete token is provisionally counted. Before appending the next delta,
its contribution is removed and the extended token is counted again. This matters
for splits such as `the` + `re`: a stopword can become a meaningful token. Each
fold remains a separate token sequence, as before. No shared or global cache is
introduced. The scorer retains vocabulary counts and an unfinished token instead
of the full response history.

## Recent research and scope

Research checked on September 16, 2026:

* [LAMaS, August 12 revision](https://arxiv.org/abs/2601.10560v2)
  optimizes orchestration latency through critical path aware training and runtime
  elimination of redundant interactions. Its lesson for this change is to measure
  latency explicitly. We do not implement its learned controller or inherit its
  reported benchmark gains. The separate July submission was withdrawn as a
  duplicate; the linked January identifier carries the current revision.
* [ProgRouter, August 30 revision](https://arxiv.org/abs/2608.25992v2)
  uses progress signals to adapt model selection across workflow steps. Cheap
  incremental state is useful infrastructure for such routing, but lexical
  relevance is not a calibrated progress estimator. Learned routing would require
  separate training data, held out task quality evaluation and budget validation.

This is an exact algorithmic optimization of the existing lexical scorer, not a
claim to outperform either research system. It does not change model selection,
quorum, signature verification, evidence requirements or promotion authority.

## Reproduction

From `packages/radio-moe` in a repository checkout:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run bench:relevance
```

The benchmark compares the production scorer against the frozen previous
algorithm at `7bf327a9754ce798364dbee8b2825af42a421fd4`. Both run in the same
process, with three warmups and nine measured passes in alternating order. Every
frame is checked against the reference before timing, with tolerance `1e-12`.
Each agent receives up to 8192 UTF-16 code units from a different repository
Markdown file in 64 code unit deltas. Frames interleave round robin; every 32nd
frame is folded into the context. JSON output includes full source file hashes,
raw samples, CPU and Node version. Corpus enumeration is sorted and recursive.

This is real repository prose with a synthetic arrival schedule, not captured
production conversations. Timings cover complete scorer replays, excluding model
inference, network, signing and frame validation. `usPerFrame` divides the median
replay time by frame count. With nine samples the reported nearest rank p95 is
the sample maximum, not a robust production tail latency estimate. No wall clock
threshold is enforced in CI.

## Safety and remaining limits

Differential tests cover every split of mixed ASCII and Unicode text, split
stopwords, empty deltas, object and null values, serialization failures, repeated
terms, long unfinished tokens, hostile looking map keys and 5000 seeded
interleaved updates with context folds. Serialization failures leave scorer state
unchanged. The scorer is a lexical signal, not a trust or authority decision.

Comparisons still scale with peer count and vocabulary size. A delimiter free
response retains and rescans its unfinished token. Unique terms, agent count and
request lifetime remain unbounded at this API, as before; callers must enforce
input and request budgets. Term frequencies also retain sensitive information,
so callers should discard the scorer when a request finishes. This change is
not a security audit of the entire repository.

Acceptance requires the existing package tests, typecheck, build and reference
comparisons to pass. A rollout should additionally measure complete request
latency on representative recorded traffic; local scorer speedups cannot be
multiplied directly into model latency or answer quality.

## Measured result

Node v24.19.0, AMD EPYC 9V74 80-Core Processor, Linux shared container. Recorded September 16, 2026.

| Agents | Frames | Before, ms | After, ms | Speedup |
| --- | --- | --- | --- | --- |
| 1 | 128 | 7.158 | 0.371 | 19.29x |
| 4 | 446 | 113.266 | 8.229 | 13.76x |
| 16 | 1802 | 2152.429 | 210.721 | 10.21x |

All replay scores matched the reference; maximum absolute difference was 0. Corpus manifest contains 18 files; each scenario uses its first N files for N agents.

[Raw samples and corpus hashes](./relevance-benchmark.json). Local validation:
169 TypeScript tests passed, one existing test skipped, 102 Rust workspace tests
passed, TypeScript typecheck and build passed, package dry run passed, and
production npm dependency audit reported zero vulnerabilities.
