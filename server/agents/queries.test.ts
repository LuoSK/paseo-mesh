import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import { peerConfigSchema } from "../../shared/config";
import type { HostRef, LocalHost } from "../hosts/host-registry";
import { PeerConnection } from "../hosts/peer-connection";
import { silentLogger } from "../logger";
import { type AgentDirectory, listAgents } from "./queries";

const local: LocalHost = {
  kind: "local",
  id: "local",
  name: "local",
  access: "write",
  allowExec: false,
  allowedPaths: [],
  serverId: "srv_LOCAL",
};
function peer(name: string, enabled = true) {
  return new PeerConnection(peerConfigSchema.parse({ name, enabled, connection: `${name}:6767` }), {
    clientId: "test",
    appVersion: "0.11.2",
    logger: silentLogger,
    onConnected() {},
    validateIdentity: () => null,
  });
}
function agent(id: string, updatedAt: string, cwd = "/srv/work"): PaseoAgent {
  return {
    id,
    title: id,
    cwd,
    status: "idle",
    provider: "echo",
    model: "echo-1",
    labels: {},
    updatedAt,
    createdAt: updatedAt,
    archivedAt: null,
  } as PaseoAgent;
}
function apiWith(agents: PaseoAgent[]) {
  const list = vi.fn().mockResolvedValue({
    entries: agents.map((agent) => ({ agent, project: null })),
    pageInfo: { hasMore: false },
  });
  return { list, api: { agents: { list } } as unknown as PaseoApi };
}

describe("listAgents", () => {
  it("merges hosts by recency, skips disabled peers, and reports unreachable ones", async () => {
    const remote = peer("remote");
    const offline = peer("offline");
    const disabled = peer("disabled", false);
    const localApi = apiWith([agent("old", "2026-01-01")]);
    const remoteApi = apiWith([
      agent("new", "2026-02-01"),
      agent("outside", "2026-03-01", "/srv/other"),
    ]);
    const api = vi.fn(async (host: HostRef) => {
      if (host.kind === "local") return localApi.api;
      if (host.peer === remote) return remoteApi.api;
      throw new Error("connection lost");
    });
    const directory: AgentDirectory = {
      localHost: () => local,
      remotePeers: () => [remote, offline, disabled],
      resolve: () => local,
      api,
    };
    const result = await listAgents(directory, {
      includeArchived: false,
      cwd: "/srv/work",
      limit: 25,
    });
    expect(result.agents.map(({ agentId, host }) => ({ agentId, host }))).toEqual([
      { agentId: "new", host: "remote" },
      { agentId: "old", host: "local" },
    ]);
    expect(result.unreachable).toEqual([{ host: "offline", error: "connection lost" }]);
    expect(api).toHaveBeenCalledTimes(3);
    expect(api).toHaveBeenCalledWith(local, 3_000);
    expect(localApi.list).toHaveBeenCalledWith({
      filter: { includeArchived: false },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 25 },
    });
  });

  it("queries only the requested host and passes archive and lifecycle filters", async () => {
    const { api, list } = apiWith([]);
    const resolve = vi.fn(() => local);
    const directory: AgentDirectory = {
      resolve,
      localHost: () => local,
      remotePeers: () => [],
      api: vi.fn(async () => api),
    };
    await listAgents(directory, {
      host: "srv_LOCAL",
      includeArchived: true,
      statuses: ["running"],
      limit: 100,
    });
    expect(resolve).toHaveBeenCalledWith("srv_LOCAL");
    expect(directory.api).toHaveBeenCalledWith(local, 10_000);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { includeArchived: true, statuses: ["running"] } }),
    );
  });

  it("propagates failures when a specific host was requested", async () => {
    const directory: AgentDirectory = {
      resolve: () => local,
      localHost: () => local,
      remotePeers: () => [],
      api: async () => {
        throw new Error("unavailable");
      },
    };
    await expect(
      listAgents(directory, { host: "local", includeArchived: false, limit: 10 }),
    ).rejects.toThrow("unavailable");
  });
});
