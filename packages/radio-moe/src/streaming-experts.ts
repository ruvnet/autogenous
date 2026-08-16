//! Streaming expert adapters — real inference backends as AgentFrame streams.
//!
//! Each expert wraps a streaming subprocess and maps its JSONL events to signed
//! `AgentFrame`s (ADR-397). Two first-class backends, both grounded in the CLIs'
//! actual streaming interfaces:
//!
//!   • Claude Code  — `claude -p --output-format stream-json --include-partial-messages`
//!   • OpenAI Codex — `codex exec --json`
//!
//! The subprocess plumbing (`CommandStreamingExpert`) is backend-agnostic: it
//! takes a spawn spec + an event parser, so it is exercised offline with a
//! deterministic fake command in the tests (no API cost, no network). The two
//! CLI factories are thin configs over it. Cancellation kills the child, which
//! ends the stream — this is how "endless loops" stay bounded and abortable.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type AgentFrame, type FrameKind, signFrame } from './agent-frame.js';
import type { PeerIdentity } from './transport.js';
import type { CapabilityVector } from './types.js';

/** A partial frame a parser emits; the runner fills id/agent/step and signs. */
export interface PartialFrame {
  kind: FrameKind;
  value: unknown;
  confidence?: number;
  uncertainty?: number;
  dependencies?: string[];
  capabilityUsed?: string;
  evidenceHashes?: string[];
  cost?: number;
}

/** Maps one parsed JSONL event to zero or more partial frames. Pure. */
export type EventParser = (event: unknown) => PartialFrame[];

/** How to launch the streaming backend for a given prompt. */
export type SpawnSpec = { command: string; args: string[] } | ((prompt: string) => { command: string; args: string[] });

export interface StreamingExpertOptions {
  /** Default capability tag stamped on frames that don't set their own. */
  capabilityUsed?: string;
  /** Extra environment for the child process. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * A streaming expert backed by a subprocess emitting JSONL. `run` yields signed
 * `AgentFrame`s as they arrive and stops when the child exits or `signal` aborts.
 */
export class CommandStreamingExpert {
  constructor(
    readonly agentId: string,
    readonly identity: PeerIdentity,
    readonly capability: CapabilityVector,
    private readonly spec: SpawnSpec,
    private readonly parser: EventParser,
    private readonly opts: StreamingExpertOptions = {},
  ) {
    if (identity.peerId !== undefined && agentId.length === 0) {
      throw new Error('agentId required');
    }
  }

  async *run(prompt: string, requestId: string, signal?: AbortSignal): AsyncGenerator<AgentFrame> {
    const { command, args } = typeof this.spec === 'function' ? this.spec(prompt) : this.spec;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(this.opts.env ? { env: { ...process.env, ...this.opts.env } } : {}),
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    });

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    if (signal) {
      if (signal.aborted) child.kill('SIGTERM');
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let step = 0;
    try {
      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // non-JSON log line — ignore
        }
        for (const p of this.parser(event)) {
          yield signFrame(this.identity, {
            requestId,
            agentId: this.agentId,
            step: step++,
            kind: p.kind,
            value: p.value,
            confidence: p.confidence ?? 0.5,
            uncertainty: p.uncertainty ?? 0.5,
            dependencies: p.dependencies ?? [],
            capabilityUsed: p.capabilityUsed ?? this.opts.capabilityUsed ?? this.agentId,
            evidenceHashes: p.evidenceHashes ?? [],
            cost: p.cost ?? 0,
          });
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!child.killed) child.kill('SIGTERM');
    }
  }
}

/** Claude Code stream-json parser. Maps assistant text deltas → `claim` frames
 *  and the final `result` event → a confident `claim` carrying the metered cost. */
export const claudeStreamParser: EventParser = (event) => {
  const e = event as Record<string, unknown>;
  // partial deltas: { type:'stream_event', event:{ type:'content_block_delta', delta:{ type:'text_delta', text } } }
  if (e.type === 'stream_event') {
    const inner = e.event as Record<string, unknown> | undefined;
    const delta = inner?.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length) {
      return [{ kind: 'claim', value: delta.text, confidence: 0.4, uncertainty: 0.6 }];
    }
    return [];
  }
  // terminal result: { type:'result', subtype:'success', result, total_cost_usd }
  if (e.type === 'result') {
    const text = typeof e.result === 'string' ? e.result : '';
    const cost = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0;
    return text ? [{ kind: 'claim', value: text, confidence: 0.85, uncertainty: 0.2, cost }] : [];
  }
  return [];
};

/** Codex `exec --json` parser (provisional — validate against a live capture).
 *  Codex emits JSONL events; this maps the common text/delta shapes to `claim`
 *  frames and a completion event to a confident final claim. */
export const codexStreamParser: EventParser = (event) => {
  const e = event as Record<string, unknown>;
  const msg = (e.msg ?? e.message ?? e) as Record<string, unknown>;
  const type = String(e.type ?? msg.type ?? '');
  // streamed text: look for a delta/text field on the event or its msg.
  const delta = (msg.delta ?? msg.text ?? e.delta ?? e.text) as unknown;
  if (typeof delta === 'string' && delta.length && !type.includes('completed')) {
    return [{ kind: 'claim', value: delta, confidence: 0.4, uncertainty: 0.6 }];
  }
  if (type.includes('completed') || type === 'item.completed' || type === 'turn.completed') {
    const finalText = (msg.text ?? msg.content ?? '') as unknown;
    return typeof finalText === 'string' && finalText.length
      ? [{ kind: 'claim', value: finalText, confidence: 0.85, uncertainty: 0.2 }]
      : [];
  }
  return [];
};

/** A streaming expert backed by `claude -p` (Claude Code headless streaming). */
export function claudeCodeStreamExpert(
  agentId: string,
  identity: PeerIdentity,
  capability: CapabilityVector,
  opts: StreamingExpertOptions & { model?: string } = {},
): CommandStreamingExpert {
  const spec: SpawnSpec = (prompt) => ({
    command: 'claude',
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      ...(opts.model ? ['--model', opts.model] : []),
      prompt,
    ],
  });
  return new CommandStreamingExpert(agentId, identity, capability, spec, claudeStreamParser, opts);
}

/** A streaming expert backed by `codex exec --json` (OpenAI Codex CLI). */
export function codexStreamExpert(
  agentId: string,
  identity: PeerIdentity,
  capability: CapabilityVector,
  opts: StreamingExpertOptions & { model?: string } = {},
): CommandStreamingExpert {
  const spec: SpawnSpec = (prompt) => ({
    command: 'codex',
    args: ['exec', '--json', ...(opts.model ? ['-m', opts.model] : []), prompt],
  });
  return new CommandStreamingExpert(agentId, identity, capability, spec, codexStreamParser, opts);
}

/**
 * Endless real-time mix loop: consume frames from several streaming experts
 * concurrently and fold each into a shared mixer the instant it arrives (the
 * MidStream mixture-plane seam). Runs until every expert ends or `signal`
 * aborts — the basis for "continuous collaborative reasoning" (ADR-397). Returns
 * the total number of frames folded.
 */
export async function endlessMixLoop(
  experts: CommandStreamingExpert[],
  prompt: string,
  requestId: string,
  onFrame: (frame: AgentFrame) => void,
  signal?: AbortSignal,
): Promise<number> {
  let folded = 0;
  await Promise.all(
    experts.map(async (expert) => {
      for await (const frame of expert.run(prompt, requestId, signal)) {
        onFrame(frame);
        folded += 1;
      }
    }),
  );
  return folded;
}
