//! HTTP streaming expert adapters — run the mesh against real hosted providers.
//!
//! `HttpStreamingExpert` POSTs a chat request with `stream: true`, reads the SSE
//! response, and maps each `data:` event to a signed `AgentFrame` (ADR-397/398).
//! The `fetch` implementation is injectable, so the tests exercise the full SSE
//! parse + sign path **offline** against a fake streaming response (no API key,
//! no network). Two provider configs ship:
//!
//!   • OpenRouter — OpenAI-compatible `/chat/completions` (`openRouterExpert`)
//!   • Google Gemini on Vertex AI — `:streamGenerateContent` (`geminiExpert`)
//!
//! No-key fallback (autonomous rule): the factories read the key/token from the
//! environment at call time; `hasCredentials()` lets a caller detect a missing
//! key and fall back to a local/mock expert rather than failing the whole run.

import { type AgentFrame, signFrame } from './agent-frame.js';
import type { EventParser, PartialFrame } from './streaming-experts.js';
import type { PeerIdentity } from './transport.js';
import type { CapabilityVector } from './types.js';

/** Minimal fetch shape we depend on (global fetch satisfies it). */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; text(): Promise<string> }>;

export interface HttpExpertConfig {
  agentId: string;
  identity: PeerIdentity;
  capability: CapabilityVector;
  endpoint: string;
  /** Resolved at call time so a rotated key/token is picked up per request. */
  headers: () => Record<string, string>;
  /** Provider-specific request body for a prompt. */
  body: (prompt: string) => unknown;
  /** Maps one parsed SSE `data:` JSON object to partial frames. */
  parser: EventParser;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** True when the required credential is present in the environment. */
  hasCredentials: () => boolean;
}

/** An expert backed by a streaming HTTP chat endpoint. */
export class HttpStreamingExpert {
  constructor(private readonly cfg: HttpExpertConfig) {}

  get agentId(): string {
    return this.cfg.agentId;
  }
  get capability(): CapabilityVector {
    return this.cfg.capability;
  }
  /** Whether this expert can actually reach its provider right now. */
  hasCredentials(): boolean {
    return this.cfg.hasCredentials();
  }

  async *run(prompt: string, requestId: string, signal?: AbortSignal): AsyncGenerator<AgentFrame> {
    const fetchImpl = this.cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const res = await fetchImpl(this.cfg.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.cfg.headers() },
      body: JSON.stringify(this.cfg.body(prompt)),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) {
      const detail = res.body ? await res.text().catch(() => '') : '';
      throw new Error(`${this.cfg.agentId}: provider HTTP ${res.status} ${detail}`.trim());
    }

    let step = 0;
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines; process complete lines.
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          const data = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!data || data === '[DONE]') continue;
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          for (const p of this.cfg.parser(event)) {
            yield sign(this.cfg.identity, this.cfg.agentId, requestId, step++, p);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

function sign(
  identity: PeerIdentity,
  agentId: string,
  requestId: string,
  step: number,
  p: PartialFrame,
): AgentFrame {
  return signFrame(identity, {
    requestId,
    agentId,
    step,
    kind: p.kind,
    value: p.value,
    confidence: p.confidence ?? 0.5,
    uncertainty: p.uncertainty ?? 0.5,
    dependencies: p.dependencies ?? [],
    capabilityUsed: p.capabilityUsed ?? agentId,
    evidenceHashes: p.evidenceHashes ?? [],
    cost: p.cost ?? 0,
  });
}

/** OpenAI-compatible SSE (OpenRouter, most hosted providers): map assistant text
 *  deltas → `claim` frames; the terminal `finish_reason` frame carries usage. */
export const openaiSseParser: EventParser = (event) => {
  const e = event as Record<string, unknown>;
  const choice = (e.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (!choice) return [];
  const delta = choice.delta as Record<string, unknown> | undefined;
  const text = delta?.content;
  const frames: PartialFrame[] = [];
  if (typeof text === 'string' && text.length) {
    frames.push({ kind: 'claim', value: text, confidence: 0.45, uncertainty: 0.55 });
  }
  if (choice.finish_reason) {
    const usage = e.usage as Record<string, unknown> | undefined;
    const cost = typeof usage?.total_tokens === 'number' ? usage.total_tokens : 0;
    frames.push({ kind: 'plan', value: `finish:${String(choice.finish_reason)}`, confidence: 0.8, cost });
  }
  return frames;
};

/** Google Gemini (Vertex AI `:streamGenerateContent`) SSE: map candidate text
 *  parts → `claim` frames. */
export const geminiSseParser: EventParser = (event) => {
  const e = event as Record<string, unknown>;
  const cand = (e.candidates as Array<Record<string, unknown>> | undefined)?.[0];
  const parts = ((cand?.content as Record<string, unknown> | undefined)?.parts) as
    | Array<Record<string, unknown>>
    | undefined;
  const frames: PartialFrame[] = [];
  for (const part of parts ?? []) {
    if (typeof part.text === 'string' && part.text.length) {
      frames.push({ kind: 'claim', value: part.text, confidence: 0.45, uncertainty: 0.55 });
    }
  }
  return frames;
};

/** An expert backed by OpenRouter (OpenAI-compatible). Key: `OPENROUTER_API_KEY`. */
export function openRouterExpert(
  agentId: string,
  identity: PeerIdentity,
  capability: CapabilityVector,
  opts: { model: string; apiKeyEnv?: string; fetchImpl?: FetchLike } = { model: 'openai/gpt-4o-mini' },
): HttpStreamingExpert {
  const keyEnv = opts.apiKeyEnv ?? 'OPENROUTER_API_KEY';
  return new HttpStreamingExpert({
    agentId,
    identity,
    capability,
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    headers: () => ({ authorization: `Bearer ${process.env[keyEnv] ?? ''}` }),
    body: (prompt) => ({
      model: opts.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
    parser: openaiSseParser,
    hasCredentials: () => Boolean(process.env[keyEnv]),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

/** An expert backed by Google Gemini on Vertex AI (`:streamGenerateContent`).
 *  Needs a GCP access token (`GEMINI_ACCESS_TOKEN`, e.g. `gcloud auth print-access-token`)
 *  plus `GEMINI_PROJECT` / `GEMINI_LOCATION`. */
export function geminiExpert(
  agentId: string,
  identity: PeerIdentity,
  capability: CapabilityVector,
  opts: { model?: string; fetchImpl?: FetchLike } = {},
): HttpStreamingExpert {
  const model = opts.model ?? 'gemini-3.7-flash';
  const project = process.env.GEMINI_PROJECT ?? '';
  // Newest Gemini models are served from the `global` location, whose host has
  // no region prefix (verified live: 200 on global, 404 on us-central1).
  const location = process.env.GEMINI_LOCATION ?? 'global';
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const endpoint =
    `https://${host}/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
  return new HttpStreamingExpert({
    agentId,
    identity,
    capability,
    endpoint,
    headers: () => ({ authorization: `Bearer ${process.env.GEMINI_ACCESS_TOKEN ?? ''}` }),
    body: (prompt) => ({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    parser: geminiSseParser,
    hasCredentials: () => Boolean(process.env.GEMINI_ACCESS_TOKEN && process.env.GEMINI_PROJECT),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
