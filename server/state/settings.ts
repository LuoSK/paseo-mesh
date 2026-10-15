import type { RpcInput } from "@getpaseo/plugin";
import { type MeshConfig, meshConfigSchema, newPeerId, type PeerConfig } from "../../shared/config";
import type { updateSettingsRpc } from "../../shared/rpc";
import { peerNameFor, type SkippedHost, type SyncedHost } from "../../shared/sync";
import { messageOf } from "../errors";
import { describeConnection, parseConnectionTarget } from "../hosts/connection-target";
import type { Logger } from "../logger";
import type { JsonFileStore } from "./json-store";

type SettingsStore = Pick<
  JsonFileStore<MeshConfig>,
  "read" | "update" | "locked" | "rawMatches" | "watch"
>;

interface MeshSettingsOptions {
  store: SettingsStore;
  logger: Logger;
  localServerId(): string | null;
  peerServerId(id: string): string | null | undefined;
  onApply(config: MeshConfig): void;
}

/** Serializes settings changes and reconciles app-managed peers with persisted configuration. */
export class MeshSettings {
  private config: MeshConfig = meshConfigSchema.parse({});
  private configError: string | null = null;
  private stopWatching: (() => void) | null = null;
  private closed = false;

  constructor(private readonly options: MeshSettingsOptions) {}

  get current(): MeshConfig {
    return this.config;
  }
  get error(): string | null {
    return this.configError;
  }

  async start(): Promise<void> {
    await this.reloadConfig();
    this.stopWatching = this.options.store.watch(() => void this.reloadConfig());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopWatching?.();
    this.stopWatching = null;
    await this.options.store.locked(async () => {});
  }

  async update(input: RpcInput<typeof updateSettingsRpc>): Promise<MeshConfig> {
    return this.mutateConfig((config) => ({
      ...config,
      ...(input.localAccess ? { localAccess: input.localAccess } : {}),
      ...(input.injection
        ? { injection: { ...config.injection, ...definedOnly(input.injection) } }
        : {}),
      ...(input.appSync
        ? {
            appSync: {
              ...config.appSync,
              ...definedOnly({ enabled: input.appSync.enabled, access: input.appSync.access }),
              ...(input.appSync.clearExcluded ? { excluded: [] } : {}),
            },
          }
        : {}),
    }));
  }

  async addPeer(input: {
    name: string;
    connection: string;
    password?: string;
    access: "read" | "write";
    allowedPaths: string[];
  }): Promise<string> {
    parseConnectionTarget(input.connection);
    const id = newPeerId();
    await this.mutateConfig((config) => {
      if (config.peers.some((peer) => peer.name === input.name)) {
        throw new Error(`A peer named "${input.name}" already exists`);
      }
      const peer: PeerConfig = {
        id,
        name: input.name,
        connection: input.connection.trim(),
        ...(input.password ? { password: input.password } : {}),
        access: input.access,
        allowedPaths: input.allowedPaths,
        enabled: true,
      };
      return { ...config, peers: [...config.peers, peer] };
    });
    return id;
  }

  async updatePeer(input: {
    id: string;
    name?: string;
    connection?: string;
    password?: string | null;
    access?: "read" | "write";
    allowedPaths?: string[];
    enabled?: boolean;
  }): Promise<string> {
    if (input.connection !== undefined) parseConnectionTarget(input.connection);
    await this.mutateConfig((config) => {
      const current = config.peers.find((peer) => peer.id === input.id);
      if (!current) throw new Error(`Unknown peer ${input.id}`);
      if (
        input.name !== undefined &&
        config.peers.some((peer) => peer.id !== input.id && peer.name === input.name)
      ) {
        throw new Error(`A peer named "${input.name}" already exists`);
      }
      const next: PeerConfig = {
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.connection !== undefined ? { connection: input.connection.trim() } : {}),
        ...(input.access !== undefined ? { access: input.access } : {}),
        ...(input.allowedPaths !== undefined ? { allowedPaths: input.allowedPaths } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      };
      if (input.password === null) delete next.password;
      else if (input.password !== undefined) next.password = input.password;
      return { ...config, peers: config.peers.map((peer) => (peer.id === input.id ? next : peer)) };
    });
    return input.id;
  }

  async removePeer(id: string): Promise<boolean> {
    let removed = false;
    await this.mutateConfig((config) => {
      const peer = config.peers.find((candidate) => candidate.id === id);
      removed = Boolean(peer);
      // Removing a synced peer by hand means "stop syncing it", or the next sync re-adds it.
      const serverId = peer?.origin ? this.peerServerId(peer) : null;
      return {
        ...config,
        peers: config.peers.filter((candidate) => candidate.id !== id),
        ...(serverId && !config.appSync.excluded.includes(serverId)
          ? { appSync: { ...config.appSync, excluded: [...config.appSync.excluded, serverId] } }
          : {}),
      };
    });
    return removed;
  }

  /**
   * Makes the peers this app manages match the app's host list: adds new hosts, updates
   * connections and passwords that changed, removes hosts the app no longer has. Peers added
   * by hand or by another app are never changed, and an excluded server is never re-added.
   */
  async syncPeers(input: {
    appId: string;
    hosts: SyncedHost[];
    skipped: SkippedHost[];
    error?: string;
  }): Promise<{ applied: boolean; added: string[]; updated: string[]; removed: string[] }> {
    const result = { added: [] as string[], updated: [] as string[], removed: [] as string[] };
    let enabled = false;
    const origin = `app:${input.appId}`;
    await this.mutateConfig((config) => {
      if (!config.appSync.enabled) return config;
      enabled = true;
      if (input.error) return config;
      const peers = [...config.peers];
      const incoming = new Map(
        input.hosts
          .filter(
            (host) =>
              host.serverId !== this.options.localServerId() &&
              !config.appSync.excluded.includes(host.serverId),
          )
          .map((host) => [host.serverId, host]),
      );
      const names = new Set(peers.map((peer) => peer.name));
      for (const host of incoming.values()) {
        const index = peers.findIndex((peer) => {
          const serverId = this.peerServerId(peer);
          // A peer that has not connected yet is matched by where it points.
          return serverId === null
            ? sameEndpoint(peer.connection, host.connection)
            : serverId === host.serverId;
        });
        const existing = index === -1 ? undefined : peers[index];
        if (existing) {
          if (existing.origin !== origin) continue;
          if (existing.connection !== host.connection || existing.password !== host.password) {
            const next: PeerConfig = {
              ...existing,
              connection: host.connection,
              serverId: host.serverId,
            };
            if (host.password) next.password = host.password;
            else delete next.password;
            peers[index] = next;
            result.updated.push(existing.name);
          }
          continue;
        }
        const name = uniqueName(peerNameFor(host.label) || "host", names);
        names.add(name);
        peers.push({
          id: newPeerId(),
          name,
          connection: host.connection,
          ...(host.password ? { password: host.password } : {}),
          serverId: host.serverId,
          origin,
          access: config.appSync.access,
          allowedPaths: [],
          enabled: true,
        });
        result.added.push(name);
      }
      const kept = peers.filter((peer) => {
        const gone = peer.origin === origin && !incoming.has(this.peerServerId(peer) ?? "");
        if (gone) result.removed.push(peer.name);
        return !gone;
      });
      return { ...config, peers: kept };
    });
    if (!enabled) return { applied: false, ...result };
    this.recordSync({ ...result, skipped: input.skipped, error: input.error ?? null });
    if (result.added.length + result.updated.length + result.removed.length > 0) {
      this.options.logger.info(
        `App sync: added ${result.added.length}, updated ${result.updated.length}, removed ${result.removed.length}`,
      );
    }
    return { applied: !input.error, ...result };
  }

  lastSync: {
    at: string;
    error: string | null;
    added: string[];
    updated: string[];
    removed: string[];
    skipped: SkippedHost[];
  } | null = null;

  private recordSync(sync: {
    error: string | null;
    added: string[];
    updated: string[];
    removed: string[];
    skipped: SkippedHost[];
  }): void {
    this.lastSync = { at: new Date().toISOString(), ...sync };
  }

  /** The daemon a peer stands for: its pinned serverId, else the one it last connected to. */
  private peerServerId(peer: PeerConfig): string | null {
    if (peer.serverId) return peer.serverId;
    const live = this.options.peerServerId(peer.id);
    if (live) return live;
    try {
      const target = parseConnectionTarget(peer.connection);
      return target.kind === "relay" ? target.serverId : null;
    } catch {
      return null;
    }
  }

  private async mutateConfig(mutate: (config: MeshConfig) => MeshConfig): Promise<MeshConfig> {
    if (this.closed) throw new Error("paseo-mesh is stopping");
    return this.options.store.update(mutate, (next) => this.applyConfig(next));
  }

  private async reloadConfig(): Promise<void> {
    try {
      // Locked so a reload triggered by an earlier write cannot apply a stale file over a
      // newer update that landed in between.
      await this.options.store.locked(async ({ write }) => {
        const config = await this.options.store.read();
        if (await this.options.store.rawMatches((raw) => peersMissingIds(raw))) {
          // Persist IDs for hand-written peers so they stay stable across reloads.
          await write(config);
        }
        this.applyConfig(config);
      });
      this.configError = null;
    } catch (error) {
      // Keep running with the last good config; surface the problem in status.
      this.configError = messageOf(error);
      this.options.logger.error(`Config not applied: ${this.configError}`);
    }
  }

  private applyConfig(config: MeshConfig): void {
    this.config = config;
    this.configError = null;
    this.options.onApply(config);
  }
}

function sameEndpoint(a: string, b: string): boolean {
  try {
    return (
      describeConnection(parseConnectionTarget(a)) === describeConnection(parseConnectionTarget(b))
    );
  } catch {
    return false;
  }
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 63 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function peersMissingIds(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const peers = (raw as { peers?: unknown }).peers;
  return (
    Array.isArray(peers) &&
    peers.some((peer) => typeof peer === "object" && peer !== null && !("id" in peer))
  );
}
