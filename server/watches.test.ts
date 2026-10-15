import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostRegistry, type WaitForFinishResult } from "./host-registry";
import { JsonFileStore } from "./json-store";
import { silentLogger } from "./logger";
import { type Watch, type WatchFile, WatchManager, watchFileSchema } from "./watches";

interface FakeAgent {
  archivedAt?: string | null;
  exists?: boolean;
  /** Results returned by successive waitForFinish calls; the last one repeats. */
  waits?: Array<WaitForFinishResult | "hang" | Error>;
  sendFailures?: number;
}

class FakeLocal {
  readonly sent: Array<{ agentId: string; text: string }> = [];
  readonly waitCalls: string[] = [];
  constructor(readonly agents: Record<string, FakeAgent>) {}

  api(): PaseoApi {
    const fake = this;
    return {
      agents: {
        ref(agentId: string) {
          const agent = fake.agents[agentId];
          return {
            async refresh() {
              if (!agent || agent.exists === false) return null;
              return {
                agent: { id: agentId, archivedAt: agent.archivedAt ?? null },
                project: null,
              };
            },
            async send(text: string) {
              if (agent?.sendFailures) {
                agent.sendFailures -= 1;
                throw new Error("local daemon busy");
              }
              fake.sent.push({ agentId, text });
            },
            async waitForFinish() {
              fake.waitCalls.push(agentId);
              const waits = agent?.waits ?? [];
              const next = waits.length > 1 ? waits.shift() : waits[0];
              if (next === "hang" || next === undefined) return new Promise(() => {});
              if (next instanceof Error) throw next;
              return next;
            },
          };
        },
      },
    } as unknown as PaseoApi;
  }
}

function result(status: WaitForFinishResult["status"], extra: Partial<WaitForFinishResult> = {}) {
  return {
    status,
    final: { title: "child", pendingPermissions: [] },
    error: null,
    lastMessage: null,
    ...extra,
  } as WaitForFinishResult;
}

function watch(overrides: Partial<Watch>): Watch {
  return {
    id: `watch_${Math.random().toString(16).slice(2)}`,
    hostId: "local",
    serverId: "srv_LOCAL",
    hostName: "local",
    agentId: "child",
    notifyAgentId: "parent",
    createdAt: new Date().toISOString(),
    notifiedPermissionIds: [],
    orphanedAt: null,
    ...overrides,
  };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("WatchManager", () => {
  let dir: string;
  let store: JsonFileStore<WatchFile>;
  let manager: WatchManager | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mesh-watches-"));
    store = new JsonFileStore(path.join(dir, "watches.json"), watchFileSchema, () =>
      watchFileSchema.parse({}),
    );
  });

  afterEach(async () => {
    await manager?.close();
    manager = null;
    await rm(dir, { recursive: true, force: true });
  });

  function start(local: FakeLocal, options: { orphanTtlMs?: number } = {}) {
    const registry = new HostRegistry({
      logger: silentLogger,
      clientId: "test",
      appVersion: "0.0.0",
      localApi: async () => local.api(),
      localServerId: () => "srv_LOCAL",
      localHostname: () => "test-host",
      localVersion: () => null,
    });
    manager = new WatchManager({
      store,
      registry,
      localApi: async () => local.api(),
      logger: silentLogger,
      retryDelayMs: 10,
      orphanTtlMs: options.orphanTtlMs ?? 60_000,
    });
    return manager;
  }

  async function seed(...watches: Watch[]) {
    await store.update((file) => ({ ...file, watches }));
  }

  async function stored(): Promise<Watch[]> {
    return (await store.read()).watches;
  }

  it("notifies the caller with the last message and removes the watch", async () => {
    const local = new FakeLocal({
      parent: {},
      child: { waits: [result("idle", { lastMessage: "all done" })] },
    });
    await seed(watch({}));
    await start(local).start();
    await waitUntil(() => local.sent.length === 1);
    expect(local.sent[0]?.text).toContain(
      "Agent child (child) on host local (srv_LOCAL) finished.",
    );
    expect(local.sent[0]?.text).toContain("all done");
    await waitUntil(async () => (await stored()).length === 0);
  });

  it("retries a failed delivery instead of dropping the notification", async () => {
    const local = new FakeLocal({
      parent: { sendFailures: 2 },
      child: { waits: [result("idle", { lastMessage: "eventually" })] },
    });
    await seed(watch({}));
    await start(local).start();
    await waitUntil(() => local.sent.length === 1);
    expect(local.sent[0]?.text).toContain("eventually");
    await waitUntil(async () => (await stored()).length === 0);
  });

  it("drops the notification for an archived caller", async () => {
    const local = new FakeLocal({
      parent: { archivedAt: "2026-01-01T00:00:00.000Z" },
      child: { waits: [result("idle")] },
    });
    await seed(watch({}));
    await start(local).start();
    await waitUntil(async () => (await stored()).length === 0);
    expect(local.sent).toEqual([]);
  });

  it("reports a deleted agent instead of an error", async () => {
    const local = new FakeLocal({
      parent: {},
      child: {
        exists: false,
        waits: [result("error", { final: null, error: "Agent not found: child" })],
      },
    });
    await seed(watch({}));
    await start(local).start();
    await waitUntil(() => local.sent.length === 1);
    expect(local.sent[0]?.text).toContain("the agent no longer exists there");
  });

  it("keeps waiting through wait failures and timeouts", async () => {
    const local = new FakeLocal({
      parent: {},
      child: {
        waits: [
          new Error("socket closed"),
          result("timeout"),
          result("idle", { lastMessage: "ok" }),
        ],
      },
    });
    await seed(watch({}));
    await start(local).start();
    await waitUntil(() => local.sent.length === 1);
    expect(local.waitCalls.length).toBe(3);
  });

  it("announces each permission request once and keeps watching", async () => {
    const permission = result("permission", {
      final: {
        title: "child",
        pendingPermissions: [{ id: "perm-1", name: "write", kind: "tool" }],
      } as unknown as WaitForFinishResult["final"],
    });
    const local = new FakeLocal({
      parent: {},
      child: {
        waits: [permission, permission, permission, result("idle", { lastMessage: "done" })],
      },
    });
    await seed(watch({}));
    await start(local).start();
    await waitUntil(() => local.sent.length === 2, 5_000);
    expect(local.sent[0]?.text).toContain("needs permission");
    expect(local.sent[0]?.text).toContain("perm-1");
    expect(local.sent[1]?.text).toContain("finished");
  });

  it("persists the orphan time so restarts do not reset the limit", async () => {
    const local = new FakeLocal({ parent: {} });
    const orphanedAt = new Date(Date.now() - 120_000).toISOString();
    await seed(watch({ hostId: "peer_0000000000000000", hostName: "gone", orphanedAt }));
    await start(local, { orphanTtlMs: 60_000 }).start();
    await waitUntil(() => local.sent.length === 1);
    expect(local.sent[0]?.text).toContain("the host was removed from mesh");
    await waitUntil(async () => (await stored()).length === 0);
  });

  it("records when a watch becomes orphaned", async () => {
    const local = new FakeLocal({ parent: {} });
    await seed(watch({ hostId: "peer_0000000000000000", hostName: "gone" }));
    await start(local).start();
    await waitUntil(async () => Boolean((await stored())[0]?.orphanedAt));
    expect(local.sent).toEqual([]);
  });

  it("stops promptly while a server-side wait is in flight and keeps the watch", async () => {
    const local = new FakeLocal({ parent: {}, child: { waits: ["hang"] } });
    await seed(watch({}));
    const watches = start(local);
    await watches.start();
    await waitUntil(() => local.waitCalls.length === 1);
    const started = Date.now();
    await watches.close();
    manager = null;
    expect(Date.now() - started).toBeLessThan(500);
    expect(await stored()).toHaveLength(1);
  });

  it("re-arming the same agent for the same caller replaces the earlier watch", async () => {
    const local = new FakeLocal({ parent: {}, child: { waits: ["hang"] } });
    const watches = start(local);
    await watches.start();
    const registry = new HostRegistry({
      logger: silentLogger,
      clientId: "t",
      appVersion: "0",
      localApi: async () => local.api(),
      localServerId: () => "srv_LOCAL",
      localHostname: () => null,
      localVersion: () => null,
    });
    await watches.add({ host: registry.localHost(), agentId: "child", notifyAgentId: "parent" });
    await watches.add({ host: registry.localHost(), agentId: "child", notifyAgentId: "parent" });
    const saved = JSON.parse(await readFile(store.filePath, "utf8")) as WatchFile;
    expect(saved.watches).toHaveLength(1);
  });
});
