# Verified rule learning (experimental)

The native `envelope` crate adds an opt-in evidence gate for competing rulebook
and executable candidates. It does not execute generated programs or assert
that learning gains have been measured in production.

Trusted rule-learning hosts call `verify_rule_learning_promotion_artifact`.
The manifest must include `verified_rule_learning_v1` in requested capabilities.
Using this dedicated entry point prevents a candidate from opting itself out.
Legacy hosts and detector candidates retain their existing behavior. A host must
choose this route by trusted workload configuration, never by candidate input.

Each of the existing two distinct constitution-pinned judges attaches a
`rule_learning::RuleLearningEvidence` to its `EvaluationReceipt` using
`with_rule_learning`. This re-signs the whole receipt with the same Ed25519 key.
The controller then signs the envelope over the updated receipt hashes. A JSON
evidence export or a SHA-256 digest alone never authorizes promotion.

The schema is `rule-learning-evidence/v1`. `run_id` equals the envelope nonce;
candidate and parent hashes match the signed wrapper; `hidden_corpus_hash`
equals its corpus identifier. All six artifact/binding hashes use lowercase
64-character hexadecimal. The parent binding uses the existing envelope
convention, `witness::content_hash(&parent.hash)`, rather than the raw genome id.
The evaluator owns the hidden corpus commitment, seeds, scorer and probes.

Acceptance requires exactly three distinct families with the same five unique
seeds, valid integer success counts, at least five samples per family, at least
20 percentage points improvement on two families, zero regressions on every
family, and at least 25% fewer total interactions. Positive replay and independent
probe counts with zero failures are required. Integer arithmetic uses 128-bit
intermediates to avoid overflow and floating-point threshold ambiguity.

Counts and coverage are signed judge attestations, not cryptographic proofs that
all seed trials happened. Operators must resolve artifact hashes against retained
rulebook, executable and trace bytes and independently replay/score them before
signing. Judges must not sign candidate-supplied scores. Generated code remains
outside this verifier and needs a separately constrained execution adapter.
The gate does not establish scientific reproducibility or patentability.

The original constitutional fitness, proof resolution, quorum, controller,
rollback and crypto checks remain mandatory. The existing promotion controller
and deployment nonce ledger own single-use protection; this stateless verifier
does not claim durable replay protection by itself. Its run binding prevents
moving previously signed evidence into a fresh envelope nonce.

Run `cargo test -p envelope -p promotion` for the existing closure tests plus
missing-evidence, tampering, failed-probe, replay binding, coverage, threshold and
overflow checks. Fixtures are synthetic and do not claim the acceptance gains.
