import { randomBytes } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { messageOf } from "../errors";
import {
  type HostOps,
  type HostRef,
  type HostRegistry,
  hostLabel,
  hostServerId,
  type WaitForFinishResult,
} from "../hosts/host-registry";
import { PeerUnavailableError } from "../hosts/peer";
import type { Logger } from "../logger";
import type { StateStore } from "../state/json-store";

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
  /** When the host stopped resolving. Persisted so restarts do not reset the orphan limit. */
  orphanedAt: z.string().nullable().default(null),
});
export type Watch = z.infer<typeof watchSchema>;

export const watchFileSchema = z.object({
  version: z.literal(1).default(1),
  watches: z.array(watchSchema).default([]),
});
export type WatchFile = z.infer<typeof watchFileSchema>;

export type FinishReason = "finished" | "errored" | "needs permission";

export interface WatchManagerOptions {
  store: StateStore<WatchFile>;
  registry: Pick<HostRegistry, "ops" | "localHost" | "peerById" | "peerByServerId">;
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
      orphanedAt: null,
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
    // Runners stop at their next await; a delivery already in flight is not waited for long,
    // because Paseo kills a plugin that takes more than a few seconds to stop.
    await Promise.race([
      Promise.allSettled(runners.map((runner) => runner.done)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
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
    let permissionDelayMs = retryDelayMs;

    while (!signal.aborted) {
      const host = this.resolveHost(watch);
      if (!host) {
        if (!watch.orphanedAt) {
          watch = await this.save({ ...watch, orphanedAt: new Date().toISOString() });
        }
        const orphanedFor = Date.now() - Date.parse(watch.orphanedAt ?? "");
        if (orphanedFor > orphanTtlMs) {
          await this.finish(watch, signal, {
            text: `[paseo-mesh] Stopped watching agent ${watch.agentId} on host ${watch.hostName}: the host was removed from mesh and did not come back.`,
          });
          return;
        }
        await this.sleep(Math.min(orphanTtlMs - orphanedFor + 10, 30_000), signal);
        continue;
      }
      if (watch.orphanedAt) watch = await this.save({ ...watch, orphanedAt: null });

      let ops: HostOps;
      try {
        ops = await this.options.registry.ops(host, retryDelayMs);
      } catch (error) {
        // Offline peers and an unreachable local daemon are both worth waiting out.
        if (!(error instanceof PeerUnavailableError)) {
          this.options.logger.warn(`Watch ${watch.id}: ${messageOf(error)}`);
        }
        await this.sleep(retryDelayMs, signal);
        continue;
      }

      let result: WaitForFinishResult | null;
      try {
        result = await abortable(ops.waitForFinish(watch.agentId, waitChunkMs), signal);
      } catch (error) {
        if (signal.aborted) return;
        if (await this.agentIsGone(ops, watch.agentId)) {
          await this.finish(watch, signal, { text: goneMessage(watch, hostLabel(host)) });
          return;
        }
        this.options.logger.warn(
          `Wait for ${watch.agentId} on ${hostLabel(host)}: ${messageOf(error)}`,
        );
        await this.sleep(retryDelayMs, signal);
        continue;
      }
      if (!result || signal.aborted) return;

      if (result.status === "timeout") continue;
      if (result.status === "permission") {
        const pending = result.final?.pendingPermissions ?? [];
        const fresh = pending.filter(
          (request) => !watch.notifiedPermissionIds.includes(request.id),
        );
        if (fresh.length > 0) {
          const outcome = await this.deliverWithRetry(
            watch,
            this.format(watch, host, "needs permission", result, fresh),
            signal,
          );
          if (outcome === "aborted") return;
          if (outcome === "caller-gone") {
            await this.remove(watch);
            return;
          }
          // Recorded only after delivery, so a failed delivery is retried on the next pass.
          watch = await this.save({
            ...watch,
            notifiedPermissionIds: pending.map((request) => request.id),
          });
          permissionDelayMs = retryDelayMs;
        } else {
          permissionDelayMs = Math.min(permissionDelayMs * 2, 30_000);
        }
        await this.sleep(permissionDelayMs, signal);
        continue;
      }
      // The daemon answers a wait for a deleted agent with an error and no snapshot.
      if (
        result.status === "error" &&
        !result.final &&
        (await this.agentIsGone(ops, watch.agentId))
      ) {
        await this.finish(watch, signal, { text: goneMessage(watch, hostLabel(host)) });
        return;
      }
      await this.finish(watch, signal, {
        text: this.format(
          watch,
          host,
          result.status === "error" ? "errored" : "finished",
          result,
          [],
        ),
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

  private async save(next: Watch): Promise<Watch> {
    await this.options.store.update((file) => ({
      ...file,
      watches: file.watches.map((existing) => (existing.id === next.id ? next : existing)),
    }));
    return next;
  }

  private async remove(watch: Watch): Promise<void> {
    await this.options.store.update((file) => ({
      ...file,
      watches: file.watches.filter((existing) => existing.id !== watch.id),
    }));
  }

  /** Delivers the final message, then deletes the watch. On abort the watch stays on disk. */
  private async finish(
    watch: Watch,
    signal: AbortSignal,
    outcome: { text: string },
  ): Promise<void> {
    const delivered = await this.deliverWithRetry(watch, outcome.text, signal);
    if (delivered === "aborted") return;
    await this.remove(watch);
  }

  private format(
    watch: Watch,
    host: HostRef,
    reason: FinishReason,
    result: WaitForFinishResult,
    permissions: readonly unknown[],
  ): string {
    return formatNotification({
      hostName: hostLabel(host),
      serverId: hostServerId(host) ?? watch.serverId,
      agentId: watch.agentId,
      title: result.final?.title ?? null,
      reason,
      error: result.error,
      lastMessage: result.lastMessage,
      permissions,
    });
  }

  /** Retries transient delivery failures with backoff until delivered or aborted. */
  private async deliverWithRetry(
    watch: Watch,
    text: string,
    signal: AbortSignal,
  ): Promise<"delivered" | "caller-gone" | "aborted"> {
    let delayMs = this.options.retryDelayMs ?? 3_000;
    while (!signal.aborted) {
      try {
        return await this.deliver(watch, text);
      } catch (error) {
        this.options.logger.warn(
          `Notifying ${watch.notifyAgentId} failed, retrying: ${messageOf(error)}`,
        );
        await this.sleep(delayMs, signal);
        delayMs = Math.min(delayMs * 2, 60_000);
      }
    }
    return "aborted";
  }

  /** Throws on transient failures; resolves "caller-gone" when the caller cannot be notified. */
  private async deliver(watch: Watch, text: string): Promise<"delivered" | "caller-gone"> {
    const parent = (await this.options.localApi()).agents.ref(watch.notifyAgentId);
    const snapshot = await parent.refresh();
    if (!snapshot) {
      this.options.logger.info(`Caller ${watch.notifyAgentId} is gone; dropping notification`);
      return "caller-gone";
    }
    if (snapshot.agent.archivedAt) {
      this.options.logger.info(`Caller ${watch.notifyAgentId} is archived; dropping notification`);
      return "caller-gone";
    }
    await parent.send(text, { activeTurnBehavior: "steer" });
    return "delivered";
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

function goneMessage(watch: Watch, hostName: string): string {
  return `[paseo-mesh] Stopped watching agent ${watch.agentId} on host ${hostName}: the agent no longer exists there.`;
}

/** Resolves with the promise's value, or null as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve(null);
  }
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
      `Answer with mesh_respond_permission host="${input.hostName}" agentId="${input.agentId}", or in the Paseo app on that host.`,
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
