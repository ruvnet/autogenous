/**
 * Fixed benchmark corpus with two regimes: balanced, decorrelated expert errors
 * where fusion can beat every single expert, and provider/architecture-correlated
 * errors where three llama experts repeat one wrong claim from shared provenance.
 * Every profile and score is deterministic from a seeded LCG; no ambient randomness
 * or external state is used.
 */

export interface ExpertProfile { id: string; provider: string; arch: string; sizeClass: 'S'|'M'|'L'|'XL'; }
export interface Task { id: string; prompt: string; groundTruth: string; }
export interface ExpertAnswer {
  claimId: string;
  quality: number;
  relevance: number;
  evidence: number;
  cost: number;
  latency: number;
  uncertainty: number;
  sourceIds: string[];
}

export const EXPERTS: ExpertProfile[] = [
  { id: 'llama-s', provider: 'meta', arch: 'llama', sizeClass: 'S' },
  { id: 'llama-m', provider: 'meta', arch: 'llama', sizeClass: 'M' },
  { id: 'llama-l', provider: 'meta', arch: 'llama', sizeClass: 'L' },
  { id: 'gemini-xl', provider: 'google', arch: 'gemini', sizeClass: 'XL' },
  { id: 'claude-xl', provider: 'anthropic', arch: 'claude', sizeClass: 'XL' },
];

const QUESTIONS: ReadonlyArray<readonly [string, string]> = [
  ['Which value equals 7 + 5? opt-a: 10; opt-b: 11; opt-c: 12; opt-d: 13', 'opt-c'],
  ['Which planet is known as the Red Planet? opt-a: Venus; opt-b: Mars; opt-c: Jupiter; opt-d: Mercury', 'opt-b'],
  ['Which is a prime number? opt-a: 21; opt-b: 27; opt-c: 29; opt-d: 33', 'opt-c'],
  ['What is the chemical symbol for gold? opt-a: Ag; opt-b: Au; opt-c: Fe; opt-d: Gd', 'opt-b'],
  ['Which data structure is FIFO? opt-a: stack; opt-b: heap; opt-c: queue; opt-d: tree', 'opt-c'],
  ['Which number is the binary 1010 in decimal? opt-a: 8; opt-b: 9; opt-c: 10; opt-d: 12', 'opt-c'],
  ['Which ocean is largest? opt-a: Atlantic; opt-b: Indian; opt-c: Arctic; opt-d: Pacific', 'opt-d'],
  ['What is the square root of 144? opt-a: 10; opt-b: 11; opt-c: 12; opt-d: 14', 'opt-c'],
  ['Which protocol normally secures HTTP? opt-a: TLS; opt-b: FTP; opt-c: SMTP; opt-d: DNS', 'opt-a'],
  ['Which language runs natively in web browsers? opt-a: Rust; opt-b: Java; opt-c: JavaScript; opt-d: Go', 'opt-c'],
  ['Which value is hexadecimal FF in decimal? opt-a: 225; opt-b: 240; opt-c: 250; opt-d: 255', 'opt-d'],
  ['Which sorting bound applies to comparison sorts in general? opt-a: O(1); opt-b: O(log n); opt-c: O(n); opt-d: O(n log n)', 'opt-d'],
  ['Which gas is most abundant in Earth\'s atmosphere? opt-a: oxygen; opt-b: nitrogen; opt-c: argon; opt-d: carbon dioxide', 'opt-b'],
  ['Which HTTP status means Not Found? opt-a: 200; opt-b: 301; opt-c: 404; opt-d: 503', 'opt-c'],
  ['What does CPU stand for? opt-a: Central Processing Unit; opt-b: Core Program Utility; opt-c: Compute Power User; opt-d: Central Protocol Unit', 'opt-a'],
  ['Which number is divisible by both 3 and 4? opt-a: 8; opt-b: 9; opt-c: 12; opt-d: 14', 'opt-c'],
  ['Which layer routes IP packets? opt-a: physical; opt-b: data link; opt-c: network; opt-d: application', 'opt-c'],
  ['Which keyword declares an immutable binding in JavaScript? opt-a: var; opt-b: let; opt-c: const; opt-d: static', 'opt-c'],
  ['Which unit measures electric current? opt-a: volt; opt-b: watt; opt-c: ampere; opt-d: ohm', 'opt-c'],
  ['Which value is 15 percent of 200? opt-a: 20; opt-b: 25; opt-c: 30; opt-d: 35', 'opt-c'],
  ['Which traversal visits root before subtrees? opt-a: preorder; opt-b: inorder; opt-c: postorder; opt-d: level only', 'opt-a'],
  ['Which SQL operation combines rows from tables? opt-a: DROP; opt-b: JOIN; opt-c: VACUUM; opt-d: GRANT', 'opt-b'],
  ['Which IPv4 address is loopback? opt-a: 0.0.0.0; opt-b: 8.8.8.8; opt-c: 127.0.0.1; opt-d: 255.255.255.0', 'opt-c'],
  ['Which property is required for a deterministic replay? opt-a: fresh entropy; opt-b: stable inputs; opt-c: wall-clock timing; opt-d: random seeds', 'opt-b'],
];

const makeTasks = (regime: 'ind' | 'corr'): Task[] => QUESTIONS.map(([prompt, groundTruth], index) => ({
  id: `${regime}-${String(index + 1).padStart(2, '0')}`,
  prompt,
  groundTruth,
}));

export const INDEPENDENT_CORPUS: Task[] = makeTasks('ind');
export const CORRELATED_CORPUS: Task[] = makeTasks('corr');

const OPTIONS = ['opt-a', 'opt-b', 'opt-c', 'opt-d'] as const;
const INDEPENDENT_ERROR_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [0, 3], [0, 4], [1, 2],
  [1, 3], [1, 4], [2, 3], [2, 4], [3, 4],
];

function seedOf(value: string): number {
  let seed = 2166136261;
  for (let i = 0; i < value.length; i += 1) seed = Math.imul(seed ^ value.charCodeAt(i), 16777619);
  return seed >>> 0;
}

function seededLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function wrongClaim(task: Task, salt: string): string {
  const correct = OPTIONS.indexOf(task.groundTruth as typeof OPTIONS[number]);
  if (correct < 0) throw new Error(`Unsupported ground truth: ${task.groundTruth}`);
  const draw = seededLcg(seedOf(`${task.id}:${salt}`))();
  return OPTIONS[(correct + 1 + Math.floor(draw * 3)) % OPTIONS.length]!;
}

function taskIndex(task: Task): number {
  const index = Number(task.id.slice(task.id.lastIndexOf('-') + 1)) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= QUESTIONS.length) throw new Error(`Unknown task: ${task.id}`);
  return index;
}

export function answer(expertId: string, task: Task): ExpertAnswer {
  const expertIndex = EXPERTS.findIndex((expert) => expert.id === expertId);
  if (expertIndex < 0) throw new Error(`Unknown expert: ${expertId}`);

  const index = taskIndex(task);
  const correlated = task.id.startsWith('corr-');
  if (!correlated && !task.id.startsWith('ind-')) throw new Error(`Unknown corpus: ${task.id}`);

  const pair = index < 20 ? INDEPENDENT_ERROR_PAIRS[Math.floor(index / 2)] : undefined;
  const independentError = pair?.includes(expertIndex) ?? false;
  const clusterError = correlated && expertIndex < 3 && index < 8;
  const outsideError = correlated && ((expertIndex === 3 && index >= 8 && index < 15)
    || (expertIndex === 4 && index >= 15 && index < 21));
  const incorrect = correlated ? clusterError || outsideError : independentError;
  const claimId = incorrect
    ? wrongClaim(task, clusterError ? 'llama-cluster' : expertId)
    : task.groundTruth;

  const draw = seededLcg(seedOf(`${expertId}:${task.id}:scores`));
  const jitter = (): number => (draw() - 0.5) * 0.06;
  const clamp = (value: number): number => Math.max(0, Math.min(1, Number(value.toFixed(3))));
  const correlatedConfidence = clusterError ? 0.1 : 0;

  return {
    claimId,
    quality: clamp((incorrect ? 0.74 : 0.82) + correlatedConfidence + jitter()),
    relevance: clamp(0.84 + jitter()),
    evidence: clamp((incorrect ? 0.7 : 0.86) + correlatedConfidence + jitter()),
    cost: clamp(0.25 + expertIndex * 0.13 + jitter()),
    latency: clamp(0.2 + expertIndex * 0.14 + jitter()),
    uncertainty: clamp((incorrect ? 0.25 : 0.13) - correlatedConfidence + jitter()),
    sourceIds: correlated && expertIndex < 3 ? ['src-llama-pool'] : [`src-${expertId}`],
  };
}
