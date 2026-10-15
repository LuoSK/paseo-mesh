import { randomBytes } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import {
  type HostOps,
  type HostRef,
  type HostRegistry,
  hostLabel,
  hostServerId,
  type WaitForFinishResult,
} from "./host-registry";
import type { JsonFileStore } from "./json-store";
import type { Logger } from "./logger";
import { messageOf, PeerUnavailableError } from "./peer-connection";

export const watchSchema = z.object({
  id: z.string(),
  /** Peer ID, or "local". Stable across renames. */
  hostId: z.string(),
  /** Daemon identity at creation. Lets a removed and re-added peer resume the watch. */
  serverId: z.string().nullable(),
  /** Display name at creation, used in messages after the peer is gone. */
  hostName: z.string(),
  agentId: z.string(),
  /** Local agent that receives the notification. */
  notifyAgentId: z.string(),
  createdAt: z.string(),
  notifiedPermissionIds: z.array(z.string()).default([]),
});
export type Watch = z.infer<typeof watchSchema>;

export const watchFileSchema = z.object({
  version: z.literal(1).default(1),
  watches: z.array(watchSchema).default([]),
});
export type WatchFile = z.infer<typeof watchFileSchema>;

export type FinishReason = "finished" | "errored" | "needs permission";

export interface WatchManagerOptions {
  store: JsonFileStore<WatchFile>;
  registry: HostRegistry;
  localApi(): Promise<PaseoApi>;
  logger: Logger;
  /** How long one server-side wait lasts before re-arming. */
  waitChunkMs?: number;
  /** A watch whose host is gone this long is dropped and the caller told why. */
  orphanTtlMs?: number;
  /** Delay between checks while waiting on an offline host or a pending permission. */
  retryDelayMs?: number;
  maxWatches?: number;
}

interface Runner {
  abort: AbortController;
  done: Promise<void>;
}

const MAX_RESPONSE_CHARS = 4000;

/**
 * Notifies a local agent when an agent it started on another host finishes, errors or asks
 * for permission, mirroring Paseo's own notifyOnFinish. Watches persist on disk, survive plugin
 * reloads and daemon restarts, follow peers across renames, and keep waiting through
 * disconnects; a watch only ends by notifying, or by telling the caller why it gave up.
 */
export class WatchManager {
  private readonly runners = new Map<string, Runner>();
  private readonly wakers = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: WatchManagerOptions) {}

  async start(): Promise<void> {
    let file: WatchFile;
    try {
      file = await this.options.store.read();
    } catch (error) {
      this.options.logger.error(`Could not load watches: ${messageOf(error)}`);
      return;
    }
    for (const watch of file.watches) this.run(watch);
  }

  /** Arms a watch. Re-arming the same agent for the same caller replaces the earlier watch. */
  async add(input: { host: HostRef; agentId: string; notifyAgentId: string }): Promise<Watch> {
    const hostId = input.host.kind === "local" ? "local" : input.host.peer.id;
    const watch: Watch = {
      id: `watch_${randomBytes(8).toString("hex")}`,
      hostId,
      serverId: hostServerId(input.host),
      hostName: hostLabel(input.host),
      agentId: input.agentId,
      notifyAgentId: input.notifyAgentId,
      createdAt: new Date().toISOString(),
      notifiedPermissionIds: [],
    };
    const replaced: string[] = [];
    const maxWatches = this.options.maxWatches ?? 500;
    await this.options.store.update((file) => {
      const kept = file.watches.filter((existing) => {
        const same =
          existing.agentId === watch.agentId &&
          existing.notifyAgentId === watch.notifyAgentId &&
          (existing.hostId === hostId ||
            (existing.serverId !== null && existing.serverId === watch.serverId));
        if (same) replaced.push(existing.id);
        return !same;
      });
      const watches = [...kept, watch];
      while (watches.length > maxWatches) {
        const dropped = watches.shift();
        if (dropped) replaced.push(dropped.id);
      }
      return { ...file, watches };
    });
    for (const id of replaced) this.stopRunner(id);
    this.run(watch);
    return watch;
  }

  async list(): Promise<Watch[]> {
    return (await this.options.store.read()).watches;
  }

  /** Wakes runners waiting on host changes: config applied, peer connected. */
  poke(): void {
    for (const wake of [...this.wakers]) wake();
  }

  async close(): Promise<void> {
    this.closed = true;
    const runners = [...this.runners.values()];
    for (const runner of runners) runner.abort.abort();
    this.poke();
    await Promise.allSettled(runners.map((runner) => runner.done));
    this.runners.clear();
  }

  private run(watch: Watch): void {
    if (this.closed) return;
    this.stopRunner(watch.id);
    const abort = new AbortController();
    const done = this.loop(watch, abort.signal)
      .catch((error) => {
        if (!abort.signal.aborted) {
          this.options.logger.error(`Watch ${watch.id} failed: ${messageOf(error)}`);
        }
      })
      .finally(() => {
        if (this.runners.get(watch.id)?.abort === abort) this.runners.delete(watch.id);
      });
    this.runners.set(watch.id, { abort, done });
  }

  private stopRunner(id: string): void {
    const runner = this.runners.get(id);
    if (!runner) return;
    runner.abort.abort();
    this.runners.delete(id);
  }

  private async loop(initial: Watch, signal: AbortSignal): Promise<void> {
    let watch = initial;
    const retryDelayMs = this.options.retryDelayMs ?? 3_000;
    const orphanTtlMs = this.options.orphanTtlMs ?? 24 * 60 * 60 * 1000;
    const waitChunkMs = this.options.waitChunkMs ?? 5 * 60 * 1000;
    let orphanSince: number | null = null;

    while (!signal.aborted) {
      const host = this.resolveHost(watch);
      if (!host) {
        orphanSince ??= Date.now();
        if (Date.now() - orphanSince > orphanTtlMs) {
          await this.finish(watch, {
            text: `[paseo-mesh] Stopped watching agent ${watch.agentId} on host ${watch.hostName}: the host was removed from mesh and did not come back.`,
          });
          return;
        }
        await this.sleep(Math.min(orphanTtlMs, 30_000), signal);
        continue;
      }
      orphanSince = null;

      let ops: HostOps;
      try {
        ops = await this.options.registry.ops(host, retryDelayMs);
      } catch (error) {
        if (!(error instanceof PeerUnavailableError)) throw error;
        await this.sleep(retryDelayMs, signal);
        continue;
      }

      let result: WaitForFinishResult;
      try {
        result = await ops.waitForFinish(watch.agentId, waitChunkMs);
      } catch (error) {
        if (signal.aborted) return;
        if (await this.agentIsGone(ops, watch.agentId)) {
          await this.finish(watch, {
            text: `[paseo-mesh] Stopped watching agent ${watch.agentId} on host ${hostLabel(host)}: the agent no longer exists there.`,
          });
          return;
        }
        this.options.logger.warn(
          `Wait for ${watch.agentId} on ${hostLabel(host)}: ${messageOf(error)}`,
        );
        await this.sleep(retryDelayMs, signal);
        continue;
      }
      if (signal.aborted) return;

      if (result.status === "timeout") continue;
      if (result.status === "permission") {
        const pending = result.final?.pendingPermissions ?? [];
        const fresh = pending.filter(
          (request) => !watch.notifiedPermissionIds.includes(request.id),
        );
        if (fresh.length > 0) {
          watch = await this.recordPermissions(
            watch,
            pending.map((request) => request.id),
          );
          await this.notify(watch, host, "needs permission", result, fresh);
        }
        await this.sleep(retryDelayMs, signal);
        continue;
      }
      await this.finish(watch, {
        host,
        reason: result.status === "error" ? "errored" : "finished",
        result,
      });
      return;
    }
  }

  private resolveHost(watch: Watch): HostRef | null {
    const registry = this.options.registry;
    if (watch.hostId === "local") return registry.localHost();
    const byId = registry.peerById(watch.hostId);
    if (byId) {
      const current = byId.identity?.serverId ?? null;
      // The peer now reaches a different daemon; the agent cannot be there.
      if (watch.serverId && current && current !== watch.serverId) return null;
      return { kind: "remote", peer: byId };
    }
    if (watch.serverId) {
      const byServer = registry.peerByServerId(watch.serverId);
      if (byServer) return { kind: "remote", peer: byServer };
    }
    return null;
  }

  private async agentIsGone(ops: HostOps, agentId: string): Promise<boolean> {
    try {
      return (await ops.api.agents.ref(agentId).refresh()) === null;
    } catch (error) {
      return /not found|unknown agent|no agent/i.test(messageOf(error));
    }
  }

  private async recordPermissions(watch: Watch, ids: string[]): Promise<Watch> {
    const next = { ...watch, notifiedPermissionIds: ids };
    await this.options.store.update((file) => ({
      ...file,
      watches: file.watches.map((existing) => (existing.id === watch.id ? next : existing)),
    }));
    return next;
  }

  private async finish(
    watch: Watch,
    outcome:
      | { text: string }
      | { host: HostRef; reason: FinishReason; result: WaitForFinishResult },
  ): Promise<void> {
    if ("text" in outcome) await this.deliver(watch, outcome.text);
    else await this.notify(watch, outcome.host, outcome.reason, outcome.result, []);
    await this.options.store.update((file) => ({
      ...file,
      watches: file.watches.filter((existing) => existing.id !== watch.id),
    }));
  }

  private async notify(
    watch: Watch,
    host: HostRef,
    reason: FinishReason,
    result: WaitForFinishResult,
    permissions: readonly unknown[],
  ): Promise<void> {
    await this.deliver(
      watch,
      formatNotification({
        hostName: hostLabel(host),
        serverId: hostServerId(host) ?? watch.serverId,
        agentId: watch.agentId,
        title: result.final?.title ?? null,
        reason,
        error: result.error,
        lastMessage: result.lastMessage,
        permissions,
      }),
    );
  }

  private async deliver(watch: Watch, text: string): Promise<void> {
    let parent: ReturnType<PaseoApi["agents"]["ref"]>;
    let snapshot: Awaited<ReturnType<typeof parent.refresh>>;
    try {
      parent = (await this.options.localApi()).agents.ref(watch.notifyAgentId);
      snapshot = await parent.refresh();
    } catch (error) {
      this.options.logger.warn(`Cannot reach caller ${watch.notifyAgentId}: ${messageOf(error)}`);
      return;
    }
    if (!snapshot) {
      this.options.logger.info(`Caller ${watch.notifyAgentId} is gone; dropping notification`);
      return;
    }
    if (snapshot.agent.archivedAt) {
      this.options.logger.info(`Caller ${watch.notifyAgentId} is archived; dropping notification`);
      return;
    }
    await parent.send(text, { activeTurnBehavior: "steer" });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done);
      this.wakers.add(done);
    });
  }
}

export function formatNotification(input: {
  hostName: string;
  serverId: string | null;
  agentId: string;
  title: string | null;
  reason: FinishReason;
  error: string | null;
  lastMessage: string | null;
  permissions: readonly unknown[];
}): string {
  const where = input.serverId ? `${input.hostName} (${input.serverId})` : input.hostName;
  const name = input.title ? ` (${input.title})` : "";
  const lines = [`[paseo-mesh] Agent ${input.agentId}${name} on host ${where} ${input.reason}.`];
  if (input.error) lines.push(`Error: ${input.error}`);
  if (input.permissions.length > 0) {
    lines.push(
      "<permission-request>",
      JSON.stringify(input.permissions, null, 2),
      "</permission-request>",
    );
    lines.push(
      `Permission requests must be answered on host ${input.hostName}, in the Paseo app or with \`paseo --host <host> permit\`.`,
    );
  }
  if (input.lastMessage) {
    const truncated = input.lastMessage.length > MAX_RESPONSE_CHARS;
    lines.push(
      "<agent-response>",
      truncated ? `${input.lastMessage.slice(0, MAX_RESPONSE_CHARS)}…` : input.lastMessage,
      "</agent-response>",
    );
    if (truncated) {
      lines.push(
        `Response truncated. Read the rest with mesh_read_timeline host="${input.hostName}" agentId="${input.agentId}".`,
      );
    }
  }
  return lines.join("\n");
}
