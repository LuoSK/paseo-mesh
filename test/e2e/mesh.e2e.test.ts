import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  callTool,
  callToolError,
  createEchoAgent,
  ECHO_MODEL,
  ECHO_PROVIDER_DIR,
  freePort,
  messages,
  ROOT,
  TestDaemon,
  tempDir,
  waitFor,
} from "./harness";

interface PeerSummary {
  id: string;
  name: string;
  status: string;
  error: string | null;
  serverId: string | null;
  kind: string;
}

interface Status {
  hosts: PeerSummary[];
  configError: string | null;
  watches: number;
  mcp: { url: string | null };
}

let a: TestDaemon;
let b: TestDaemon;
let c: TestDaemon;
let workA: string;
let workB: string;
const PASSWORD = "c-secret-pass-123";
const openClients: McpClient[] = [];

async function status(): Promise<Status> {
  return a.rpc<Status>("mesh.status", {});
}

async function host(name: string): Promise<PeerSummary | undefined> {
  return (await status()).hosts.find((entry) => entry.name === name);
}

async function waitStatus(name: string, wanted: string, timeoutMs = 30_000): Promise<PeerSummary> {
  return waitFor(
    async () => {
      const entry = await host(name);
      return entry?.status === wanted ? entry : null;
    },
    { timeoutMs, message: `${name} never became ${wanted}` },
  );
}

async function addPeer(
  name: string,
  connection: string,
  extra: Record<string, unknown> = {},
): Promise<PeerSummary> {
  return a.rpc<PeerSummary>("mesh.peers.add", { name, connection, access: "write", ...extra });
}

async function mcp(agentId?: string): Promise<McpClient> {
  const client = await a.mcp(agentId);
  openClients.push(client);
  return client;
}

async function orchestrator(title: string): Promise<string> {
  const api = await a.api();
  return createEchoAgent(api, { cwd: workA, title, prompt: "ready" });
}

async function waitForNotification(agentId: string, needle: string, timeoutMs = 45_000) {
  const api = await a.api();
  return waitFor(
    async () => {
      const all = await messages(api, agentId);
      return all.find((text) => text.startsWith("[paseo-mesh]") && text.includes(needle)) ?? null;
    },
    { timeoutMs, message: `No mesh notification containing "${needle}" for ${agentId}` },
  );
}

beforeAll(async () => {
  workA = tempDir("work-a");
  workB = tempDir("work-b");
  [a, b, c] = await Promise.all([
    TestDaemon.start({ name: "a", plugins: [ROOT, ECHO_PROVIDER_DIR] }),
    TestDaemon.start({ name: "b", plugins: [ECHO_PROVIDER_DIR] }),
    TestDaemon.start({ name: "c", plugins: [ECHO_PROVIDER_DIR], password: PASSWORD }),
  ]);
  await a.waitForMesh();
});

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close().catch(() => {})));
  const current = await status();
  for (const peer of current.hosts.filter((entry) => entry.name !== "local")) {
    await a.rpc("mesh.peers.remove", { id: peer.id });
  }
  await a.closeClients();
});

afterAll(async () => {
  await Promise.all([a?.destroy(), b?.destroy(), c?.destroy()]);
  await Promise.all([workA, workB].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin", () => {
  it("compiles its client bundle and reports running", async () => {
    const client = await a.client();
    const catalog = await client.getPluginCatalog();
    const mesh = catalog.find((entry) => entry.id === "mesh");
    expect(mesh?.clientBundle.length).toBeGreaterThan(1000);
    const plugins = await client.listPlugins();
    expect(plugins.find((plugin) => plugin.id === "mesh")).toMatchObject({ status: "running" });
  });
});

describe("injection", () => {
  it("gives new agents the mesh MCP server and binds them as callers", async () => {
    const id = await orchestrator("inject");
    const record = await a.agentRecord(id);
    const mesh = record.config.mcpServers?.mesh;
    expect(mesh?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\?caller=c[0-9a-f]{24}$/);
    expect(mesh?.headers?.Authorization).toMatch(/^Bearer [0-9a-f]{48}$/);

    const client = await mcp(id);
    const { hosts } = await callTool<{ hosts: Array<{ name: string; serverId: string }> }>(
      client,
      "mesh_list_hosts",
      {},
    );
    expect(hosts).toEqual([expect.objectContaining({ name: "local", serverId: a.serverId })]);

    const callers = JSON.parse(await readFile(path.join(a.meshDataDir(), "callers.json"), "utf8"));
    const nonce = new URL(mesh?.url ?? "").searchParams.get("caller") ?? "";
    expect(callers.callers[nonce].agentId).toBe(id);
  });

  it("the echo agent can reach mesh tools through the injected server", async () => {
    const api = await a.api();
    const id = await createEchoAgent(api, {
      cwd: workA,
      title: "self-call",
      prompt: "MCP mesh mesh_list_hosts {}",
    });
    const all = await messages(api, id);
    expect(all.at(-1)).toContain(`"serverId": "${a.serverId}"`);
  });
});

describe("peers", () => {
  it("connects to a peer, verifies its identity and reads its agents", async () => {
    const added = await addPeer("b", b.endpoint);
    expect(added.kind).toBe("direct");
    const online = await waitStatus("b", "online");
    expect(online.serverId).toBe(b.serverId);

    const bApi = await b.api();
    const remoteId = await createEchoAgent(bApi, {
      cwd: workB,
      title: "native-b",
      prompt: "hello from b",
    });

    const client = await mcp();
    const listed = await callTool<{ agents: Array<{ agentId: string; host: string }> }>(
      client,
      "mesh_list_agents",
      { host: "b" },
    );
    expect(listed.agents.map((agent) => agent.agentId)).toContain(remoteId);

    const all = await callTool<{ agents: Array<{ host: string }>; unreachable: unknown[] }>(
      client,
      "mesh_list_agents",
      {},
    );
    expect(new Set(all.agents.map((agent) => agent.host))).toEqual(new Set(["local", "b"]));
    expect(all.unreachable).toEqual([]);

    const timeline = await callTool<{ items: Array<{ type: string; text?: string }> }>(
      client,
      "mesh_read_timeline",
      { host: "b", agentId: remoteId },
    );
    expect(timeline.items).toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "Echo: hello from b" }),
    );

    const agent = await callTool<{ lastAssistantMessage: string; serverId: string }>(
      client,
      "mesh_get_agent",
      { host: b.serverId, agentId: remoteId },
    );
    expect(agent.lastAssistantMessage).toBe("Echo: hello from b");
    expect(agent.serverId).toBe(b.serverId);

    const workspaces = await callTool<{ workspaces: Array<{ directory: string }> }>(
      client,
      "mesh_list_workspaces",
      { host: "b" },
    );
    expect(workspaces.workspaces.map((workspace) => workspace.directory)).toContain(workB);

    const providers = await callTool<{
      providers: Array<{ provider: string; models: Array<{ id: string }> }>;
    }>(client, "mesh_list_providers", { host: "b" });
    const echo = providers.providers.find((provider) => provider.provider === "mesh-echo");
    expect(echo?.models.map((model) => model.id)).toContain(ECHO_MODEL);
  });

  it("authenticates with a password, reports a wrong one, and recovers when fixed", async () => {
    const added = await addPeer("c", c.endpoint, { password: "wrong-password" });
    const offline = await waitFor(
      async () => {
        const entry = await host("c");
        return entry?.status === "offline" && entry.error ? entry : null;
      },
      { message: "wrong password never reported" },
    );
    expect(offline.error).toBeTruthy();
    await a.rpc("mesh.peers.update", { id: added.id, password: PASSWORD });
    const online = await waitStatus("c", "online");
    expect(online.serverId).toBe(c.serverId);

    const serialized = JSON.stringify(await status());
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("wrong-password");
  });

  it("rejects a peer that points back to this daemon and a duplicate of another peer", async () => {
    await addPeer("self", a.endpoint);
    const self = await waitStatus("self", "error");
    expect(self.error).toMatch(/points back to this daemon/);

    const first = await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    await addPeer("b-dup", `ws://${b.endpoint}`);
    const dup = await waitStatus("b-dup", "error");
    expect(dup.error).toMatch(/Same daemon as peer "b"/);

    await a.rpc("mesh.peers.remove", { id: first.id });
    await waitStatus("b-dup", "online");
  });

  it("validates connections and names before saving", async () => {
    await expect(addPeer("bad", "ssh://me@box")).rejects.toThrow(/Unsupported connection/);
    await expect(addPeer("Local", b.endpoint)).rejects.toThrow();
    await addPeer("b", b.endpoint);
    await expect(addPeer("b", c.endpoint)).rejects.toThrow(/already exists/);
  });

  it("reports unreachable hosts without failing an all-host listing", async () => {
    const closedPort = await freePort();
    await addPeer("ghost", `127.0.0.1:${closedPort}`);
    await waitStatus("ghost", "offline");
    const client = await mcp();
    const all = await callTool<{
      agents: unknown[];
      unreachable: Array<{ host: string; error: string }>;
    }>(client, "mesh_list_agents", {});
    expect(all.unreachable.map((entry) => entry.host)).toEqual(["ghost"]);
    const error = await callToolError(client, "mesh_list_agents", { host: "ghost" });
    expect(error).toMatch(/Host "ghost" is offline/);
    expect(await callToolError(client, "mesh_list_agents", { host: "nowhere" })).toMatch(
      /Unknown host "nowhere"/,
    );
  });

  it("stops connecting when disabled and reconnects when enabled", async () => {
    const added = await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    await a.rpc("mesh.peers.update", { id: added.id, enabled: false });
    await waitStatus("b", "disabled");
    const client = await mcp();
    expect(await callToolError(client, "mesh_list_agents", { host: "b" })).toMatch(/disabled/);
    await a.rpc("mesh.peers.update", { id: added.id, enabled: true });
    await waitStatus("b", "online");
  });
});

describe("access control", () => {
  it("blocks writes to read-only peers and paths outside allowedPaths", async () => {
    const added = await addPeer("b", b.endpoint, { access: "read" });
    await waitStatus("b", "online");
    const client = await mcp();
    const create = { host: "b", cwd: workB, provider: ECHO_MODEL, prompt: "hi" };
    expect(await callToolError(client, "mesh_create_agent", create)).toMatch(/read-only/);

    const allowed = path.join(workB, "allowed");
    await mkdir(allowed, { recursive: true });
    await a.rpc("mesh.peers.update", { id: added.id, access: "write", allowedPaths: [allowed] });
    expect(await callToolError(client, "mesh_create_agent", create)).toMatch(/outside the paths/);
    expect(
      await callToolError(client, "mesh_create_agent", { ...create, cwd: `${allowed}-sibling` }),
    ).toMatch(/outside the paths/);
    expect(
      await callToolError(client, "mesh_create_agent", { ...create, cwd: "relative/dir" }),
    ).toMatch(/absolute path/);
    expect(
      await callToolError(client, "mesh_create_agent", { ...create, cwd: `${allowed}/../..` }),
    ).toMatch(/outside the paths/);
    const created = await callTool<{ agentId: string; notifyOnFinish: boolean }>(
      client,
      "mesh_create_agent",
      { ...create, cwd: allowed },
    );
    expect(created.agentId).toBeTruthy();
    // Anonymous callers cannot receive notifications.
    expect(created.notifyOnFinish).toBe(false);

    // Agents outside the allowed paths cannot be controlled either.
    await a.rpc("mesh.peers.update", { id: added.id, allowedPaths: [`${workB}/elsewhere`] });
    expect(
      await callToolError(client, "mesh_send_prompt", {
        host: "b",
        agentId: created.agentId,
        prompt: "hi",
      }),
    ).toMatch(/outside the paths/);
  });

  it("rejects malformed tool arguments with a readable message", async () => {
    const client = await mcp();
    expect(await callToolError(client, "mesh_read_timeline", { host: "local" })).toMatch(
      /Invalid arguments/,
    );
  });
});

describe("cross-host orchestration", () => {
  it("creates a remote agent and notifies the caller when it finishes", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-create");
    const client = await mcp(parent);
    const created = await callTool<{ agentId: string; notifyOnFinish: boolean; serverId: string }>(
      client,
      "mesh_create_agent",
      {
        host: "b",
        cwd: workB,
        provider: ECHO_MODEL,
        prompt: "SLEEP 1500 remote done",
        title: "child-create",
      },
    );
    expect(created.notifyOnFinish).toBe(true);
    expect(created.serverId).toBe(b.serverId);

    const note = await waitForNotification(parent, created.agentId);
    expect(note).toContain("on host b");
    expect(note).toContain("finished");
    expect(note).toContain("Echo: remote done");

    const bApi = await b.api();
    const child = await bApi.agents.ref(created.agentId).refresh();
    expect(child?.agent.labels).toMatchObject({
      "paseo-mesh.caller-agent-id": parent,
      "paseo-mesh.caller-server-id": a.serverId,
    });
  });

  it("accepts a bare provider id and picks that host's default model", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const client = await mcp();
    const created = await callTool<{ provider: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: "mesh-echo",
      prompt: "hi",
      notifyOnFinish: false,
    });
    expect(created.provider).toBe(ECHO_MODEL);
    expect(
      await callToolError(client, "mesh_create_agent", {
        host: "b",
        cwd: workB,
        provider: "no-such-provider",
        prompt: "hi",
      }),
    ).toMatch(/not available on that host/);
  });

  it("sends follow-ups, waits for them and reports failures", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-send");
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "first",
      notifyOnFinish: false,
    });
    await callTool(client, "mesh_wait_agent", { host: "b", agentId, timeoutSeconds: 30 });

    await callTool(client, "mesh_send_prompt", {
      host: "b",
      agentId,
      prompt: "SLEEP 800 second",
      notifyOnFinish: false,
    });
    const waited = await callTool<{ status: string; lastMessage: string }>(
      client,
      "mesh_wait_agent",
      { host: "b", agentId, timeoutSeconds: 30 },
    );
    expect(waited).toMatchObject({ status: "idle", lastMessage: "Echo: second" });

    await callTool(client, "mesh_send_prompt", {
      host: "b",
      agentId,
      prompt: "FAIL boom on b",
    });
    const note = await waitForNotification(parent, agentId);
    expect(note).toMatch(/errored|finished/);
  });

  it("forwards remote permission requests and lets the caller answer them", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-permission");
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "PERMIT the release notes",
    });
    const ask = await waitForNotification(parent, "needs permission");
    expect(ask).toContain(agentId);
    expect(ask).toContain("<permission-request>");
    expect(ask).toContain("Echo wants to write the release notes");
    expect(ask).toContain("mesh_respond_permission");

    const agent = await callTool<{ pendingPermissions: Array<{ id: string }> }>(
      client,
      "mesh_get_agent",
      { host: "b", agentId },
    );
    const requestId = agent.pendingPermissions[0]?.id ?? "";
    expect(
      await callToolError(client, "mesh_respond_permission", {
        host: "b",
        agentId,
        requestId: "not-a-request",
        decision: "allow",
      }),
    ).toMatch(/No pending permission/);
    await callTool(client, "mesh_respond_permission", {
      host: "b",
      agentId,
      requestId,
      decision: "allow",
    });
    const done = await waitForNotification(parent, `${agentId} (`);
    await waitFor(
      async () => {
        const api = await a.api();
        const all = await messages(api, parent);
        return all.some((text) => text.includes(agentId) && text.includes("Permission allow"));
      },
      { message: "no finish notification after allowing" },
    );
    expect(done).toContain(agentId);
  });

  it("stops a running remote turn", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const client = await mcp();
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "SLEEP 60000 never",
      notifyOnFinish: false,
    });
    const stopped = await callTool<{ stopped: boolean }>(client, "mesh_stop_agent", {
      host: "b",
      agentId,
    });
    expect(stopped.stopped).toBe(true);
    const waited = await callTool<{ status: string }>(client, "mesh_wait_agent", {
      host: "b",
      agentId,
      timeoutSeconds: 30,
    });
    expect(waited.status).not.toBe("timeout");
    expect(await callToolError(client, "mesh_stop_agent", { host: "local", agentId })).toMatch(
      /not available through mesh|not found/,
    );
  });

  it("archives remote agents", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const client = await mcp();
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "to archive",
      notifyOnFinish: false,
    });
    await callTool(client, "mesh_wait_agent", { host: "b", agentId, timeoutSeconds: 30 });
    const archived = await callTool<{ archivedAt: string }>(client, "mesh_archive_agent", {
      host: "b",
      agentId,
    });
    expect(archived.archivedAt).toBeTruthy();
    const active = await callTool<{ agents: Array<{ agentId: string }> }>(
      client,
      "mesh_list_agents",
      {
        host: "b",
      },
    );
    expect(active.agents.map((agent) => agent.agentId)).not.toContain(agentId);
  });
});

describe("host changes while work is in flight", () => {
  it("renaming a peer keeps its connection and pending notifications", async () => {
    const added = await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-rename");
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "SLEEP 3000 renamed",
    });
    const renamed = await a.rpc<PeerSummary>("mesh.peers.update", {
      id: added.id,
      name: "b-renamed",
    });
    expect(renamed.status).toBe("online");
    expect(await callToolError(client, "mesh_get_agent", { host: "b", agentId })).toMatch(
      /Unknown host "b"/,
    );
    await callTool(client, "mesh_get_agent", { host: "b-renamed", agentId });
    await callTool(client, "mesh_get_agent", { host: added.id, agentId });

    const note = await waitForNotification(parent, agentId);
    expect(note).toContain("on host b-renamed");
    expect(note).toContain("Echo: renamed");
  });

  it("holds notifications while a peer is removed and resumes when the daemon is re-added", async () => {
    const added = await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-remove");
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "SLEEP 2500 survived removal",
    });
    await a.rpc("mesh.peers.remove", { id: added.id });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const api = await a.api();
    expect((await messages(api, parent)).some((text) => text.includes(agentId))).toBe(false);
    expect((await status()).watches).toBeGreaterThanOrEqual(1);

    await addPeer("b-again", `ws://${b.endpoint}/ws`);
    const note = await waitForNotification(parent, agentId);
    expect(note).toContain("on host b-again");
    expect(note).toContain("Echo: survived removal");
  });

  it("reconnects after the peer daemon restarts and still notifies", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-restart");
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "SLEEP 60000 interrupted by restart",
    });
    await b.stopProcess();
    await waitStatus("b", "offline");
    await b.startProcess();
    await waitStatus("b", "online", 60_000);

    const note = await waitForNotification(parent, agentId, 90_000);
    expect(note).toMatch(/finished|errored/);
    const listed = await callTool<{ agents: Array<{ agentId: string }> }>(
      client,
      "mesh_list_agents",
      {
        host: "b",
      },
    );
    expect(listed.agents.map((agent) => agent.agentId)).toContain(agentId);
  });

  it("tells the caller when the remote agent is deleted", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-delete");
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "SLEEP 60000 will be deleted",
    });
    await b.cli(["delete", agentId]);
    const note = await waitForNotification(parent, agentId);
    expect(note).toMatch(/no longer exists|finished|errored/);
    await waitFor(async () => (await status()).watches === 0, { message: "watch not cleared" });
  });

  it("drops notifications for archived callers", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-archived");
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "SLEEP 1500 nobody listens",
    });
    const api = await a.api();
    await api.agents.ref(parent).archive();
    await waitFor(async () => (await status()).watches === 0, { message: "watch not cleared" });
    const all = await messages(api, parent);
    expect(all.some((text) => text.includes(agentId))).toBe(false);
    const refreshed = await api.agents.ref(parent).refresh();
    expect(refreshed?.agent.archivedAt).toBeTruthy();
  });

  it("restores watches, the MCP endpoint and local access after a plugin reload", async () => {
    await addPeer("b", b.endpoint);
    await waitStatus("b", "online");
    const parent = await orchestrator("parent-reload");
    const before = await a.meshServer();
    const client = await mcp(parent);
    const { agentId } = await callTool<{ agentId: string }>(client, "mesh_create_agent", {
      host: "b",
      cwd: workB,
      provider: ECHO_MODEL,
      prompt: "SLEEP 4000 after reload",
    });
    await a.reloadPlugin("mesh");
    expect(await a.meshServer()).toEqual(before);

    // No hook has run since the reload; local tools must still work.
    const fresh = await mcp(parent);
    const local = await callTool<{ agents: Array<{ agentId: string }> }>(
      fresh,
      "mesh_list_agents",
      {
        host: "local",
      },
    );
    expect(local.agents.map((agent) => agent.agentId)).toContain(parent);

    const note = await waitForNotification(parent, agentId);
    expect(note).toContain("Echo: after reload");
  });
});

describe("configuration file", () => {
  it("assigns IDs to hand-written peers and survives a corrupt edit", async () => {
    const file = path.join(a.meshDataDir(), "config.json");
    const current = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({
        ...current,
        peers: [{ name: "hand-b", connection: b.endpoint, access: "read" }],
      }),
    );
    const online = await waitStatus("hand-b", "online");
    expect(online.id).toMatch(/^peer_[0-9a-f]{16}$/);
    await waitFor(async () => {
      const saved = JSON.parse(await readFile(file, "utf8"));
      return saved.peers[0]?.id === online.id;
    });

    await writeFile(file, "{ this is not json");
    const broken = await waitFor(async () => {
      const value = await status();
      return value.configError ? value : null;
    });
    expect(broken.configError).toMatch(/not valid JSON/);
    expect(broken.hosts.find((entry) => entry.name === "hand-b")?.status).toBe("online");

    await writeFile(file, JSON.stringify({ ...current, peers: [] }));
    await waitFor(async () => {
      const value = await status();
      return value.configError === null && !value.hosts.some((entry) => entry.name === "hand-b");
    });
  });

  it("flags one of two peers that reach the same daemon at the same moment", async () => {
    const file = path.join(a.meshDataDir(), "config.json");
    const current = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({
        ...current,
        peers: [
          { name: "twin-1", connection: b.endpoint },
          { name: "twin-2", connection: `ws://${b.endpoint}/ws` },
        ],
      }),
    );
    const settled = await waitFor(async () => {
      const hosts = (await status()).hosts.filter((entry) => entry.name.startsWith("twin-"));
      const statuses = hosts.map((entry) => entry.status).sort();
      return statuses.join(",") === "error,online" ? hosts : null;
    });
    expect(settled.find((entry) => entry.status === "error")?.error).toMatch(/Same daemon as/);
  });

  it("updates one injection setting without resetting the others", async () => {
    await a.rpc("mesh.settings.update", { injection: { preapproveReadOnlyTools: false } });
    try {
      const after = await a.rpc<{
        injection: { enabled: boolean; preapproveReadOnlyTools: boolean };
      }>("mesh.settings.update", { injection: { enabled: true } });
      expect(after.injection).toMatchObject({ enabled: true, preapproveReadOnlyTools: false });
    } finally {
      await a.rpc("mesh.settings.update", { injection: { preapproveReadOnlyTools: true } });
    }
  });

  it("gives an agent created from a copied config its own caller identity", async () => {
    const parent = await orchestrator("copy-source");
    const copied = (await a.agentRecord(parent)).config.mcpServers ?? {};
    const api = await a.api();
    const workspace = await api.workspaces.open(workA);
    const child = await workspace.agents.create({
      config: { provider: ECHO_MODEL, mcpServers: copied as never },
      title: "copy-target",
      prompt: "ready",
    });
    await child.waitForFinish(30_000);
    const parentUrl = new URL(copied.mesh?.url ?? "");
    const childUrl = new URL((await a.agentRecord(child.id)).config.mcpServers?.mesh?.url ?? "");
    expect(childUrl.searchParams.get("caller")).not.toBe(parentUrl.searchParams.get("caller"));
    const callers = JSON.parse(await readFile(path.join(a.meshDataDir(), "callers.json"), "utf8"));
    expect(callers.callers[childUrl.searchParams.get("caller") ?? ""].agentId).toBe(child.id);
  });

  it("can turn off injection and preapproval for new agents", async () => {
    await a.rpc("mesh.settings.update", { injection: { enabled: false } });
    try {
      const id = await orchestrator("no-inject");
      expect((await a.agentRecord(id)).config.mcpServers?.mesh).toBeUndefined();
    } finally {
      await a.rpc("mesh.settings.update", { injection: { enabled: true } });
    }
  });
});

describe.runIf(process.env.MESH_E2E_RELAY === "1")("relay (uses relay.paseo.sh)", () => {
  let r: TestDaemon;

  beforeAll(async () => {
    r = await TestDaemon.start({ name: "r", plugins: [ECHO_PROVIDER_DIR], relay: true });
  });

  afterAll(async () => {
    await r?.destroy();
  });

  it("connects through a pairing offer and a relay:// URI with end-to-end encryption", async () => {
    const pairing = JSON.parse(await r.cli(["daemon", "pair", "--relay", "--json"])) as {
      url: string;
      connectionUri: string;
    };
    const viaOffer = await addPeer("relay-offer", pairing.url);
    expect(viaOffer.kind).toBe("relay");
    const online = await waitStatus("relay-offer", "online", 60_000);
    expect(online.serverId).toBe(r.serverId);

    const rApi = await r.api();
    const remoteId = await createEchoAgent(rApi, {
      cwd: workB,
      title: "via-relay",
      prompt: "over relay",
    });
    const client = await mcp();
    const timeline = await callTool<{ items: Array<{ text?: string }> }>(
      client,
      "mesh_read_timeline",
      {
        host: "relay-offer",
        agentId: remoteId,
      },
    );
    expect(timeline.items.map((item) => item.text)).toContain("Echo: over relay");

    await a.rpc("mesh.peers.remove", { id: viaOffer.id });
    await addPeer("relay-uri", pairing.connectionUri);
    await waitStatus("relay-uri", "online", 60_000);
  });
});

describe("distribution", () => {
  it("installs from a Git source with its declared preparation step", async () => {
    const g = await TestDaemon.start({ name: "git", plugins: [] });
    // CI checks out tags with a detached HEAD, which leaves a clone without origin/HEAD.
    // Install from a clone of the current commit on a named branch, like a real remote.
    const source = tempDir("git-source");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["clone", "-q", ROOT, source]);
    execFileSync("git", ["-C", source, "checkout", "-q", "-B", "mesh-e2e"]);
    try {
      await g.cli(["plugin", "install", `file://${source}`, "--json"]);
      await g.waitForMesh();
      const client = await g.client();
      const plugins = await client.listPlugins();
      expect(plugins.find((plugin) => plugin.id === "mesh")).toMatchObject({ status: "running" });
      const catalog = await client.getPluginCatalog();
      expect(catalog.find((entry) => entry.id === "mesh")?.clientBundle.length).toBeGreaterThan(
        1000,
      );
    } finally {
      await g.destroy();
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe("paseo-mesh CLI", () => {
  async function meshCli(args: string[], input?: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [path.join(ROOT, "bin/paseo-mesh.mjs"), "--home", a.home, ...args],
        { env: { ...process.env, PASEO_HOME: "" }, timeout: 60_000 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  it("manages peers and reports status through the plugin", async () => {
    const added = JSON.parse(
      await meshCli(
        ["peers", "add", "cli-c", c.endpoint, "--write", "--password-stdin", "--json"],
        `${PASSWORD}\n`,
      ),
    );
    expect(added).toMatchObject({ name: "cli-c", access: "write", hasPassword: true });
    await waitStatus("cli-c", "online");

    const text = await meshCli(["status"]);
    expect(text).toMatch(/cli-c\s+online\s+write/);
    expect(text).not.toContain(PASSWORD);

    await meshCli(["peers", "set", "cli-c", "--name", "cli-c2", "--read", "--allow", "/srv/work"]);
    const renamed = await host("cli-c2");
    expect(renamed).toMatchObject({
      status: "online",
      access: "read",
      allowedPaths: ["/srv/work"],
    });

    await meshCli(["peers", "remove", added.id]);
    expect(await host("cli-c2")).toBeUndefined();
    await expect(meshCli(["peers", "remove", "nope"])).rejects.toThrow(/Unknown peer "nope"/);
  });
});
