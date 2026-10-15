import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import {
  type HostStatus,
  meshConfigSchema,
  type PeerConfig,
  type PeerSummary,
} from "../../shared/config";
import { silentLogger } from "../logger";
import { HostRegistry } from "./host-registry";
import type { Peer, PeerLifecycle, ServerIdentity } from "./peer";

class FakePeer implements Peer {
  status: HostStatus = "connecting";
  identity: ServerIdentity | null = null;
  claimedServerId: string | null = null;
  error: string | null = null;
  constructor(public peerConfig: PeerConfig) {}
  get id() {
    return this.peerConfig.id;
  }
  get name() {
    return this.peerConfig.name;
  }
  start = vi.fn();
  close = vi.fn(async () => {});
  retryNow = vi.fn();
  session = vi.fn<Peer["session"]>();
  update = vi.fn((config: PeerConfig) => {
    this.peerConfig = config;
  });
  summary(): PeerSummary {
    return {
      ...this.peerConfig,
      local: false,
      kind: "direct",
      endpoint: this.peerConfig.connection,
      hasPassword: false,
      status: this.status,
      error: this.error,
      serverId: this.identity?.serverId ?? this.peerConfig.serverId ?? null,
      hostname: this.identity?.hostname ?? null,
      version: this.identity?.version ?? null,
      synced: false,
    };
  }
}

function setup() {
  const lifecycles = new Map<string, PeerLifecycle>();
  const createPeer = vi.fn((config: PeerConfig, lifecycle: PeerLifecycle) => {
    lifecycles.set(config.id, lifecycle);
    return new FakePeer(config);
  });
  const onPeerConnected = vi.fn();
  const registry = new HostRegistry({
    logger: silentLogger,
    createPeer,
    onPeerConnected,
    localApi: async () => {
      throw new Error("Local API not supplied");
    },
    localServerId: () => "srv_LOCAL",
    localHostname: () => "local machine",
    localVersion: () => null,
  });
  const config = meshConfigSchema.parse({
    peers: [
      { name: "first", connection: "first:6767" },
      { name: "second", connection: "second:6767", serverId: "srv_SECOND" },
    ],
  });
  registry.apply(config);
  const peers = createPeer.mock.results.map((result) => result.value);
  return { registry, createPeer, onPeerConnected, lifecycles, config, peers };
}

describe("HostRegistry", () => {
  it("retains connections across unchanged settings and renames, and closes removed peers", async () => {
    const {
      registry,
      createPeer,
      config,
      peers: [first, second],
    } = setup();
    expect(first.start).toHaveBeenCalledOnce();
    registry.apply(config);
    expect(createPeer).toHaveBeenCalledTimes(2);
    expect(first.update).not.toHaveBeenCalled();
    const renamed = { ...config.peers[0], name: "renamed", access: "write" as const };
    registry.apply({ ...config, peers: [renamed, config.peers[1]] });
    expect(registry.resolve("renamed")).toEqual({ kind: "remote", peer: first });
    expect(first.update).toHaveBeenCalledWith(renamed);
    expect(first.start).toHaveBeenCalledOnce();
    registry.apply({ ...config, peers: [renamed] });
    expect(second.close).toHaveBeenCalledOnce();
    await registry.close();
    expect(first.close).toHaveBeenCalledOnce();
    expect(registry.remotePeers()).toEqual([]);
  });

  it("resolves hosts by case-insensitive name, peer ID, pinned ID and verified identity", () => {
    const {
      registry,
      peers: [first, second],
    } = setup();
    first.identity = { serverId: "srv_FIRST", hostname: "first machine", version: "0.11.2" };
    for (const ref of ["FIRST", first.id, "srv_FIRST"])
      expect(registry.resolve(ref)).toEqual({ kind: "remote", peer: first });
    expect(registry.resolve("srv_SECOND")).toEqual({ kind: "remote", peer: second });
    expect(registry.resolve("srv_LOCAL").kind).toBe("local");
    expect(() => registry.resolve("unknown")).toThrow("Unknown host");
  });

  it("rejects self connections and concurrent claims for the same daemon", () => {
    const {
      lifecycles,
      onPeerConnected,
      peers: [first, second],
    } = setup();
    const lifecycle = lifecycles.get(second.id);
    expect(
      lifecycle?.validateIdentity(second, { serverId: "srv_LOCAL", hostname: null, version: null }),
    ).toContain("points back");
    first.claimedServerId = "srv_FIRST";
    expect(
      lifecycle?.validateIdentity(second, { serverId: "srv_FIRST", hostname: null, version: null }),
    ).toContain('Same daemon as peer "first"');
    expect(
      lifecycle?.validateIdentity(second, { serverId: "srv_OTHER", hostname: null, version: null }),
    ).toBeNull();
    lifecycle?.onConnected(second);
    expect(onPeerConnected).toHaveBeenCalledWith(second);
  });

  it("retries a duplicate peer after its conflicting peer is removed", () => {
    const {
      registry,
      config,
      peers: [, second],
    } = setup();
    second.status = "error";
    second.error = 'Same daemon as peer "first"';
    registry.apply({ ...config, peers: [config.peers[1]] });
    expect(second.retryNow).toHaveBeenCalledOnce();
  });

  it("delegates agent operations to the supplied peer session", async () => {
    const {
      registry,
      peers: [first],
    } = setup();
    const api = {} as PaseoApi;
    const daemon = {
      waitForFinish: vi.fn().mockResolvedValue({ status: "idle" }),
      cancelAgent: vi.fn().mockResolvedValue(undefined),
    };
    first.session.mockResolvedValue({ api, daemon });
    const ops = await registry.ops({ kind: "remote", peer: first }, 250);
    expect(ops.api).toBe(api);
    expect(first.session).toHaveBeenCalledWith(250);
    await ops.waitForFinish("agent", 500);
    await ops.cancel("agent");
    expect(daemon.waitForFinish).toHaveBeenCalledWith("agent", 500);
    expect(daemon.cancelAgent).toHaveBeenCalledWith("agent");
  });
});
