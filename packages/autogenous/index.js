// autogenous — the Autogenous Genome Language (AGL) admission and promotion
// checks, compiled from the `agl-types` Rust crate to WebAssembly.
// Every decision is made by the Rust code; this file only marshals JSON.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasm = require('./wasm/autogenous_wasm.cjs');

/** Authority classes, lowest to highest (ADR-392 §6.3). */
export const AUTHORITIES = Object.freeze([
  'observe_only',
  'simulate_only',
  'auto_reversible',
  'governed',
  'constitutional',
]);

/** Mutation scopes, lowest to highest risk (ADR-392 §6.1). */
export const MUTATION_SCOPES = Object.freeze([
  'prompt_context',
  'routing_budget',
  'retrieval_rerank',
  'cache_memory',
  'agent_topology',
  'application_code',
  'schema_migration',
  'security_policy',
  'compiler_ir',
  'constitutional',
]);

/** The ADR-392 §14 first production hard gates, as defined in Rust. */
export const DEFAULT_HARD_GATES = Object.freeze(JSON.parse(wasm.defaultHardGatesJson()));

const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** The admission error's variant name in snake_case, e.g. `no_rollback`. */
export function admissionReason(error) {
  if (typeof error === 'string') return snake(error);
  if (error && typeof error === 'object') {
    const [variant] = Object.keys(error);
    if (variant) return snake(variant);
  }
  return 'unknown';
}

/**
 * Run AGL's typed admission check (`Mutation::admissible`). `now` is unix
 * seconds and is required, so the decision is reproducible.
 */
export function admitMutation(mutation, parent, now) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative safe integer (unix seconds)');
  }
  const out = JSON.parse(wasm.admitMutationJson(JSON.stringify(mutation), JSON.stringify(parent), now));
  if (out.admissible === true) return { admissible: true };
  return { admissible: false, error: out.error, reason: admissionReason(out.error) };
}

/** Whether a scope may ever auto-promote, and the minimum authority it needs. */
export function scopePolicy(scope) {
  const out = JSON.parse(wasm.scopePolicyJson(String(scope)));
  return { scope: out.scope, autoPromotable: out.auto_promotable, minAuthority: out.min_authority };
}

/** AGL's hard AND-gate over a fitness vector (`FitnessVector::passes_hard_gates`). */
export function passesHardGates(fitness, gates) {
  return wasm.passesHardGatesJson(JSON.stringify(fitness), gates === undefined ? '' : JSON.stringify(gates));
}
