import type { PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import {
  LOCAL_HOST_NAME,
  type MeshConfig,
  meshConfigSchema,
  type PeerConfig,
  type PeerSummary,
} from "../shared/config";
import type { Logger } from "./logger";
import { PeerConnection, PeerUnavailableError, type ServerIdentity } from "./peer-connection";

export interface LocalHost {
  readonly kind: "local";
  readonly id: "local";
  readonly name: typeof LOCAL_HOST_NAME;
  readonly access: MeshConfig["localAccess"];
  readonly allowedPaths: readonly string[];
  readonly serverId: string | null;
}

export interface RemoteHost {
  readonly kind: "remote";
  readonly peer: PeerConnection;
}

export type HostRef = LocalHost | RemoteHost;

export type WaitForFinishResult = Awaited<ReturnType<PaseoAgentHandle["waitForFinish"]>>;

export interface HostOps {
  api: PaseoApi;
  /** Resolves when the agent's current turn ends or needs attention; "timeout" when it did not. */
  waitForFinish(agentId: string, timeoutMs: number): Promise<WaitForFinishResult>;
  cancel(agentId: string): Promise<void>;
}

export interface HostRegistryOptions {
  logger: Logger;
  clientId: string;
  appVersion: string;
  localApi(): Promise<PaseoApi>;
  localServerId(): string | null;
  localHostname(): string | null;
  localVersion(): string | null;
  onPeerConnected?(peer: PeerConnection): void;
  connectTimeoutMs?: number;
  retry?: { baseDelayMs: number; maxDelayMs: number };
}

export class UnknownHostError extends Error {
  constructor(ref: string, known: readonly string[]) {
    super(
      `Unknown host "${ref}". Known hosts: ${known.length ? known.join(", ") : "(none)"}. Use mesh_list_hosts to see them.`,
    );
    this.name = "UnknownHostError";
  }
}

/**
 * The set of hosts mesh can reach: this daemon as `local`, plus one supervised connection per
 * configured peer. Config changes are applied as a diff keyed by peer ID, so renaming a peer or
 * changing its access never drops its connection.
 */
export class HostRegistry {
  private readonly peers = new Map<string, PeerConnection>();
  private config: MeshConfig = meshConfigSchema.parse({});

  constructor(private readonly options: HostRegistryOptions) {}

  apply(config: MeshConfig): void {
    this.config = config;
    const nextIds = new Set(config.peers.map((peer) => peer.id));
    for (const [id, peer] of this.peers) {
      if (!nextIds.has(id)) {
        this.peers.delete(id);
        this.options.logger.info(`Peer ${peer.name} removed`);
        void peer.close();
      }
    }
    for (const peerConfig of config.peers) {
      const existing = this.peers.get(peerConfig.id);
      if (existing) {
        if (!samePeerConfig(existing.peerConfig, peerConfig)) existing.update(peerConfig);
        continue;
      }
      const peer = new PeerConnection(peerConfig, {
        clientId: `${this.options.clientId}:${peerConfig.id}`,
        appVersion: this.options.appVersion,
        logger: this.options.logger,
        connectTimeoutMs: this.options.connectTimeoutMs,
        retry: this.options.retry,
        validateIdentity: (candidate, identity) => this.validateIdentity(candidate, identity),
        onConnected: (connected) => this.options.onPeerConnected?.(connected),
      });
      this.peers.set(peerConfig.id, peer);
      peer.start();
    }
    // A peer that failed only because it duplicated a removed or disabled peer may now be valid.
    for (const peer of this.peers.values()) {
      if (peer.status === "error" && peer.summary().error?.startsWith("Same daemon as")) {
        peer.retryNow();
      }
    }
  }

  get localAccess(): MeshConfig["localAccess"] {
    return this.config.localAccess;
  }

  remotePeers(): PeerConnection[] {
    return [...this.peers.values()];
  }

  peerById(id: string): PeerConnection | null {
    return this.peers.get(id) ?? null;
  }

  /** Finds the peer currently or last known to reach `serverId`. */
  peerByServerId(serverId: string): PeerConnection | null {
    for (const peer of this.peers.values()) {
      if (peer.identity?.serverId === serverId) return peer;
    }
    for (const peer of this.peers.values()) {
      if (peer.summary().serverId === serverId) return peer;
    }
    return null;
  }

  /**
   * Resolves a host reference: `local`, a peer name (case-insensitive), a peer ID, or a
   * daemon serverId. Accepting stable IDs lets callers keep working across renames.
   */
  resolve(ref: string): HostRef {
    const value = ref.trim();
    const lower = value.toLowerCase();
    const localServerId = this.options.localServerId();
    if (lower === LOCAL_HOST_NAME || (localServerId !== null && value === localServerId)) {
      return this.localHost();
    }
    for (const peer of this.peers.values()) {
      if (peer.name === lower || peer.id === value) return { kind: "remote", peer };
    }
    const byServer = this.peerByServerId(value);
    if (byServer) return { kind: "remote", peer: byServer };
    throw new UnknownHostError(value, [
      LOCAL_HOST_NAME,
      ...[...this.peers.values()].map((p) => p.name),
    ]);
  }

  localHost(): LocalHost {
    return {
      kind: "local",
      id: "local",
      name: LOCAL_HOST_NAME,
      access: this.config.localAccess,
      allowedPaths: [],
      serverId: this.options.localServerId(),
    };
  }

  async api(host: HostRef, timeoutMs: number): Promise<PaseoApi> {
    return (await this.ops(host, timeoutMs)).api;
  }

  /** Uniform operations across this daemon and remote peers. */
  async ops(host: HostRef, timeoutMs: number): Promise<HostOps> {
    if (host.kind === "local") {
      const api = await this.options.localApi();
      return {
        api,
        waitForFinish: (agentId, waitMs) => api.agents.ref(agentId).waitForFinish(waitMs),
        async cancel() {
          throw new Error(
            "Stopping agents on the local host is not available through mesh; use Paseo's own cancel_agent tool",
          );
        },
      };
    }
    const { api, daemon } = await host.peer.session(timeoutMs);
    return {
      api,
      waitForFinish: (agentId, waitMs) => daemon.waitForFinish(agentId, waitMs),
      cancel: (agentId) => daemon.cancelAgent(agentId),
    };
  }

  summaries(): PeerSummary[] {
    return [this.localSummary(), ...[...this.peers.values()].map((peer) => peer.summary())];
  }

  localSummary(): PeerSummary {
    return {
      id: "local",
      name: LOCAL_HOST_NAME,
      local: true,
      kind: "local",
      endpoint: "this daemon",
      access: this.config.localAccess,
      allowedPaths: [],
      enabled: true,
      hasPassword: false,
      status: "online",
      error: null,
      serverId: this.options.localServerId(),
      hostname: this.options.localHostname(),
      version: this.options.localVersion(),
    };
  }

  async close(): Promise<void> {
    const peers = [...this.peers.values()];
    this.peers.clear();
    await Promise.all(peers.map((peer) => peer.close()));
  }

  private validateIdentity(candidate: PeerConnection, identity: ServerIdentity): string | null {
    const localServerId = this.options.localServerId();
    if (localServerId && identity.serverId === localServerId) {
      return "This peer points back to this daemon; use the local host instead";
    }
    for (const other of this.peers.values()) {
      if (other === candidate || other.status !== "online") continue;
      if (other.identity?.serverId === identity.serverId) {
        return `Same daemon as peer "${other.name}" (${identity.serverId})`;
      }
    }
    return null;
  }
}

export function hostLabel(host: HostRef): string {
  return host.kind === "local" ? LOCAL_HOST_NAME : host.peer.name;
}

export function hostAccess(host: HostRef): "read" | "write" {
  return host.kind === "local" ? host.access : host.peer.peerConfig.access;
}

export function hostAllowedPaths(host: HostRef): readonly string[] {
  return host.kind === "local" ? host.allowedPaths : host.peer.peerConfig.allowedPaths;
}

export function hostServerId(host: HostRef): string | null {
  return host.kind === "local" ? host.serverId : (host.peer.identity?.serverId ?? null);
}

function samePeerConfig(a: PeerConfig, b: PeerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export { PeerUnavailableError };
