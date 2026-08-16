//! Harness-pod integration (ADR-399 update): run a `create-agent-harness` pod —
//! e.g. `ruvnet/metaharness/kimi-k3-harness` — as streaming mesh experts.
//!
//! Grounded shape (kimi-k3-harness @ metaharness main): each agent module in
//! `src/agents/*.ts` exports `SYSTEM_PROMPT` (template literal), `NAME`, and
//! `TIER` ('opus' | 'sonnet' | 'haiku'); `.harness/manifest.json` lists the
//! agent files. `loadHarnessAgents` parses those generated modules statically
//! (no TS execution), and `harnessPodExperts` turns each into a
//! `CommandStreamingExpert` backed by `claude -p --append-system-prompt` —
//! so the harness's architect/implementer/reviewer/test-writer stream
//! concurrently as ONE signed mixture (the ADR-398 distributed-software-
//! engineering wedge), with every frame ed25519-signed and RVF-packageable.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CommandStreamingExpert,
  claudeStreamParser,
  type SpawnSpec,
} from './streaming-experts.js';
import { PeerIdentity } from './transport.js';
import type { CapabilityVector } from './types.js';

/** One agent role from a create-agent-harness pod. */
export interface HarnessAgentDef {
  name: string;
  systemPrompt: string;
  tier: 'opus' | 'sonnet' | 'haiku';
}

const TIERS = new Set(['opus', 'sonnet', 'haiku']);

/** Statically parse one generated agent module (SYSTEM_PROMPT/NAME/TIER). */
export function parseAgentModule(source: string): HarnessAgentDef | null {
  const prompt = source.match(/export const SYSTEM_PROMPT = `([\s\S]*?)`;/)?.[1];
  const name = source.match(/export const NAME = '([^']+)'/)?.[1];
  const tier = source.match(/export const TIER = '([^']+)'/)?.[1];
  if (!prompt || !name || !tier || !TIERS.has(tier)) return null;
  return { name, systemPrompt: prompt, tier: tier as HarnessAgentDef['tier'] };
}

/** Load every agent role from a harness checkout's `src/agents/` directory. */
export function loadHarnessAgents(harnessDir: string): HarnessAgentDef[] {
  const dir = join(harnessDir, 'src', 'agents');
  const defs: HarnessAgentDef[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.ts')) continue;
    const def = parseAgentModule(readFileSync(join(dir, f), 'utf-8'));
    if (def) defs.push(def);
  }
  return defs;
}

/** Deterministic per-role capability vector: one-hot by position, scaled by tier
 *  (opus > sonnet > haiku) so the gate prefers stronger tiers on ties. */
export function roleCapability(index: number, count: number, tier: HarnessAgentDef['tier']): CapabilityVector {
  const scale = tier === 'opus' ? 1 : tier === 'sonnet' ? 0.8 : 0.6;
  return Array.from({ length: count }, (_, k) => (k === index ? scale : 0));
}

/** Default backend: `claude -p` streaming with the role's system prompt. */
function claudeSpawn(def: HarnessAgentDef): SpawnSpec {
  return (prompt: string) => ({
    command: 'claude',
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--append-system-prompt',
      def.systemPrompt,
      prompt,
    ],
  });
}

/**
 * Instantiate a harness pod as mesh experts — one signed streaming expert per
 * agent role. `spawnFor` is injectable so tests run offline against a fake
 * subprocess; the default is the real `claude -p` backend.
 */
export function harnessPodExperts(
  defs: HarnessAgentDef[],
  spawnFor: (def: HarnessAgentDef) => SpawnSpec = claudeSpawn,
): { def: HarnessAgentDef; identity: PeerIdentity; expert: CommandStreamingExpert }[] {
  return defs.map((def, i) => {
    const identity = PeerIdentity.generate();
    const expert = new CommandStreamingExpert(
      def.name,
      identity,
      roleCapability(i, defs.length, def.tier),
      spawnFor(def),
      claudeStreamParser,
      { capabilityUsed: `harness:${def.name}` },
    );
    return { def, identity, expert };
  });
}
