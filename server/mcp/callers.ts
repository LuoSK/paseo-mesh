import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { StateStore } from "../state/json-store";
import type { McpCaller } from "./http";

/** Env var carrying an agent's caller nonce from agent.create to agent.session_open. */
export const CALLER_ENV = "PASEO_MESH_CALLER";

const callerEntrySchema = z.object({
  agentId: z.string().nullable(),
  createdAt: z.string(),
});

export const callerFileSchema = z.object({
  version: z.literal(1).default(1),
  callers: z.record(z.string(), callerEntrySchema).default({}),
});
export type CallerFile = z.infer<typeof callerFileSchema>;

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Oldest entries beyond this are dropped; their agents keep the tools but lose notifications. */
const MAX_CALLERS = 5_000;

/**
 * Maps MCP caller nonces to local agent IDs.
 *
 * `agent.create` runs before the daemon assigns an agent ID, so the plugin puts a random nonce
 * in both the injected MCP URL and the create env. The env reaches `agent.session_open`, which
 * knows the agent ID. The URL (and its nonce) persists with the agent config, so the mapping
 * is persisted too and keeps working after resumes and restarts.
 */
export class CallerRegistry {
  private cache: CallerFile = { version: 1, callers: {} };

  constructor(private readonly store: StateStore<CallerFile>) {}

  async load(): Promise<void> {
    this.cache = await this.store.read();
    await this.prune();
  }

  async issue(): Promise<string> {
    const nonce = `c${randomBytes(12).toString("hex")}`;
    this.cache = await this.store.update((file) => {
      const callers = pruned(file.callers, Date.now());
      callers[nonce] = { agentId: null, createdAt: new Date().toISOString() };
      return { ...file, callers };
    });
    return nonce;
  }

  async bind(nonce: string, agentId: string): Promise<void> {
    const existing = this.cache.callers[nonce];
    if (!existing || existing.agentId === agentId) return;
    // A nonce binds once. A later session claiming it with another ID is ignored.
    if (existing.agentId !== null) return;
    this.cache = await this.store.update((file) => {
      const entry = file.callers[nonce];
      if (!entry || entry.agentId !== null) return file;
      return { ...file, callers: { ...file.callers, [nonce]: { ...entry, agentId } } };
    });
  }

  resolve(caller: McpCaller): string | null {
    if (!caller.nonce) return null;
    return this.cache.callers[caller.nonce]?.agentId ?? null;
  }

  private async prune(): Promise<void> {
    const next = pruned(this.cache.callers, Date.now());
    if (Object.keys(next).length === Object.keys(this.cache.callers).length) return;
    this.cache = await this.store.update((file) => ({
      ...file,
      callers: pruned(file.callers, Date.now()),
    }));
  }
}

/** Drops unbound nonces older than a day, then the oldest entries beyond MAX_CALLERS. */
export function pruned(
  callers: CallerFile["callers"],
  now: number,
  max = MAX_CALLERS,
): CallerFile["callers"] {
  const fresh = Object.entries(callers).filter(
    ([, entry]) => entry.agentId !== null || now - Date.parse(entry.createdAt) < PENDING_TTL_MS,
  );
  fresh.sort(([, a], [, b]) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return Object.fromEntries(fresh.slice(Math.max(0, fresh.length - (max - 1))));
}
