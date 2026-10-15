import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MeshConfig, meshConfigSchema } from "../../shared/config";
import type { SyncedHost } from "../../shared/sync";
import { silentLogger } from "../logger";
import { JsonFileStore } from "./json-store";
import { MeshSettings } from "./settings";

describe("MeshSettings", () => {
  let dir: string;
  let store: JsonFileStore<MeshConfig>;
  let settings: MeshSettings;
  let reload: () => void;
  let applied: MeshConfig[];
  const host: SyncedHost = { serverId: "srv_B", label: "Build server", connection: "build:6767" };
  const sync = (hosts = [host]) =>
    settings.syncPeers({ appId: "app-test-123", hosts, skipped: [] });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mesh-settings-"));
    store = new JsonFileStore(path.join(dir, "config.json"), meshConfigSchema, () =>
      meshConfigSchema.parse({}),
    );
    vi.spyOn(store, "watch").mockImplementation((callback) => {
      reload = callback;
      return () => {};
    });
    applied = [];
    settings = new MeshSettings({
      store,
      logger: silentLogger,
      localServerId: () => "srv_LOCAL",
      peerServerId: () => null,
      onApply: (config) => applied.push(config),
    });
    await settings.start();
  });

  afterEach(async () => {
    await settings.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serializes concurrent edits and preserves untouched settings", async () => {
    await Promise.all([
      settings.update({ injection: { enabled: false } }),
      settings.update({ localAccess: "read", appSync: { enabled: true } }),
      settings.addPeer({
        name: "manual",
        connection: "manual:6767",
        access: "write",
        allowedPaths: [],
      }),
    ]);
    expect(settings.current).toEqual(await store.read());
    expect(settings.current).toMatchObject({
      localAccess: "read",
      injection: { enabled: false, preapproveReadOnlyTools: true },
      appSync: { enabled: true },
      peers: [{ name: "manual", access: "write" }],
    });
    expect(applied.at(-1)).toEqual(settings.current);
  });

  it("honors disabling sync ahead of a queued sync", async () => {
    await settings.update({ appSync: { enabled: true } });
    const disable = settings.update({ appSync: { enabled: false } });
    const result = sync();
    await disable;
    expect(await result).toEqual({ applied: false, added: [], updated: [], removed: [] });
    expect(settings.current.peers).toEqual([]);
  });

  it("honors enabling sync ahead of a queued sync", async () => {
    const enable = settings.update({ appSync: { enabled: true } });
    const result = sync();
    await enable;
    expect(await result).toMatchObject({ applied: true, added: ["build-server"] });
  });

  it("updates only its own peers and preserves access, names and paths", async () => {
    await settings.update({ appSync: { enabled: true } });
    await sync();
    const id = settings.current.peers[0].id;
    await settings.updatePeer({
      id,
      name: "builder",
      access: "write",
      allowedPaths: ["/srv/work"],
    });
    await settings.addPeer({
      name: "manual",
      connection: "manual:6767",
      access: "read",
      allowedPaths: [],
    });
    await settings.syncPeers({
      appId: "another-app",
      hosts: [{ ...host, serverId: "srv_C", connection: "other:6767", label: "Other" }],
      skipped: [],
    });
    await sync([{ ...host, connection: "new-build:6767", password: "new-secret" }]);
    expect(settings.current.peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id,
          name: "builder",
          access: "write",
          allowedPaths: ["/srv/work"],
          connection: "new-build:6767",
          password: "new-secret",
        }),
        expect.objectContaining({ name: "manual" }),
        expect.objectContaining({ origin: "app:another-app" }),
      ]),
    );
    await sync();
    expect(settings.current.peers.find((peer) => peer.id === id)).not.toHaveProperty("password");
    await sync([]);
    expect(settings.current.peers.map((peer) => peer.name)).toEqual(["manual", "other"]);
  });

  it("keeps a removed synced host excluded until exclusions are cleared", async () => {
    await settings.update({ appSync: { enabled: true } });
    await sync();
    await settings.removePeer(settings.current.peers[0].id);
    await sync();
    expect(settings.current.peers).toEqual([]);
    expect(settings.current.appSync.excluded).toEqual([host.serverId]);
    await settings.update({ appSync: { clearExcluded: true } });
    await sync();
    expect(settings.current.peers).toHaveLength(1);
  });

  it("does not replace a manual peer that has not connected yet", async () => {
    await settings.addPeer({
      name: "manual",
      connection: "ws://build:6767/ws",
      access: "write",
      allowedPaths: [],
    });
    await settings.update({ appSync: { enabled: true } });
    expect(await sync()).toMatchObject({ added: [], removed: [] });
    expect(settings.current.peers).toMatchObject([{ name: "manual", access: "write" }]);
    expect(settings.current.peers[0]).not.toHaveProperty("origin");
  });

  it("retains peers on an app error and omits the local host", async () => {
    await settings.update({ appSync: { enabled: true } });
    await sync([host, { ...host, serverId: "srv_LOCAL", label: "Self" }]);
    expect(settings.current.peers).toHaveLength(1);
    expect(
      await settings.syncPeers({
        appId: "app-test-123",
        hosts: [],
        skipped: [],
        error: "Unsupported registry",
      }),
    ).toMatchObject({ applied: false });
    expect(settings.current.peers).toHaveLength(1);
    expect(settings.lastSync?.error).toBe("Unsupported registry");
  });

  it("assigns valid unique names for hundreds of identically labeled hosts", async () => {
    await settings.update({ appSync: { enabled: true } });
    const hosts = Array.from({ length: 101 }, (_, i) => ({
      ...host,
      serverId: `srv_${i}`,
      label: "a".repeat(63),
      connection: `host-${i}:6767`,
    }));
    await sync(hosts);
    expect(settings.current.peers).toHaveLength(101);
    expect(new Set(settings.current.peers.map((peer) => peer.name)).size).toBe(101);
  });

  it("keeps the last good config on an invalid external edit and recovers", async () => {
    await settings.update({ localAccess: "read" });
    await writeFile(store.filePath, "{");
    reload();
    await vi.waitFor(() => expect(settings.error).toContain("not valid JSON"));
    expect(settings.current.localAccess).toBe("read");
    await writeFile(store.filePath, JSON.stringify({ localAccess: "write" }));
    reload();
    await vi.waitFor(() => expect(settings.current.localAccess).toBe("write"));
    expect(settings.error).toBeNull();
  });

  it("persists stable IDs for hand-written peers", async () => {
    await writeFile(
      store.filePath,
      JSON.stringify({ peers: [{ name: "manual", connection: "manual:6767" }] }),
    );
    reload();
    await vi.waitFor(() => expect(settings.current.peers).toHaveLength(1));
    const raw = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(raw.peers[0].id).toBe(settings.current.peers[0].id);
    reload();
    await store.locked(async () => {});
    expect(settings.current.peers[0].id).toBe(raw.peers[0].id);
  });

  it("drains pending reloads before closing and rejects subsequent edits", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "read").mockImplementationOnce(async () => {
      await blocked;
      return meshConfigSchema.parse({ localAccess: "read" });
    });
    reload();
    const closing = settings.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(settings.current.localAccess).toBe("read");
    await expect(settings.update({ localAccess: "write" })).rejects.toThrow("stopping");
  });
});
