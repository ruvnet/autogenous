/** Authority classes, lowest to highest (ADR-392 §6.3). */
export type Authority = 'observe_only' | 'simulate_only' | 'auto_reversible' | 'governed' | 'constitutional';

/** Mutation scopes, lowest to highest risk (ADR-392 §6.1). */
export type MutationScope =
  | 'prompt_context'
  | 'routing_budget'
  | 'retrieval_rerank'
  | 'cache_memory'
  | 'agent_topology'
  | 'application_code'
  | 'schema_migration'
  | 'security_policy'
  | 'compiler_ir'
  | 'constitutional';

export interface HardInvariant {
  name: string;
  /** True when the invariant currently holds (as last verified). */
  holds: boolean;
}

export interface Genome {
  hash: string;
  identity: string;
  constitution: string;
  capability_ceiling: Authority;
  hard_invariants: HardInvariant[];
  lineage: string[];
}

export interface Applicability {
  workloads: string[];
  environments: string[];
  jurisdictions: string[];
}

export interface Mutation {
  id: string;
  parent_genome_hash: string;
  scope: MutationScope;
  requested_authority: Authority;
  applicability: Applicability;
  preserved_invariants: HardInvariant[];
  /** Required: irreversible mutations are inadmissible. */
  rollback_target: string | null;
  /** Unix seconds after which the mutation is inadmissible. */
  expires_at: number | null;
  signature: string | null;
}

export interface FitnessVector {
  task_quality: number;
  safety: number;
  governance: number;
  reliability: number;
  p99_overhead_ms: number;
  false_positive_rate: number;
  regression_count: number;
  rollback_verified: boolean;
}

export interface HardGates {
  min_safety: number;
  min_governance: number;
  max_false_positive_rate: number;
  max_p99_overhead_ms: number;
}

export type AdmissionError =
  | { AuthorityExpansion: { requested: Authority; ceiling: Authority } }
  | { AuthorityInsufficient: { requested: Authority; required: Authority } }
  | { InvariantRegressed: string }
  | 'ParentMismatch'
  | 'ConstitutionalScope'
  | 'NoRollback'
  | 'Expired';

export type AdmissionReason =
  | 'authority_expansion'
  | 'authority_insufficient'
  | 'invariant_regressed'
  | 'parent_mismatch'
  | 'constitutional_scope'
  | 'no_rollback'
  | 'expired';

export type AdmissionResult =
  | { admissible: true }
  | { admissible: false; error: AdmissionError; reason: AdmissionReason };

export interface ScopePolicy {
  scope: MutationScope;
  autoPromotable: boolean;
  minAuthority: Authority;
}

export declare const AUTHORITIES: readonly Authority[];
export declare const MUTATION_SCOPES: readonly MutationScope[];
export declare const DEFAULT_HARD_GATES: Readonly<HardGates>;

export declare function admissionReason(error: AdmissionError): AdmissionReason;
/** AGL `Mutation::admissible`. `now` is unix seconds. Throws on malformed input. */
export declare function admitMutation(mutation: Mutation, parent: Genome, now: number): AdmissionResult;
/** Throws on an unknown scope. */
export declare function scopePolicy(scope: MutationScope): ScopePolicy;
/** AGL `FitnessVector::passes_hard_gates`; `gates` defaults to DEFAULT_HARD_GATES. */
export declare function passesHardGates(fitness: FitnessVector, gates?: HardGates): boolean;
