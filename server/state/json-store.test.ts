import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonFileStore } from "./json-store";

const schema = z.object({ count: z.number().int(), names: z.array(z.string()).default([]) });

describe("JsonFileStore", () => {
  let dir: string;
  let store: JsonFileStore<z.infer<typeof schema>>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mesh-store-"));
    store = new JsonFileStore(path.join(dir, "nested", "state.json"), schema, () => ({
      count: 0,
      names: [],
    }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the fallback when the file does not exist", async () => {
    expect(await store.read()).toEqual({ count: 0, names: [] });
  });

  it("writes atomically with owner-only permissions", async () => {
    await store.update((current) => ({ ...current, count: current.count + 1 }));
    const info = await stat(store.filePath);
    expect(info.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual({ count: 1, names: [] });
  });

  it("serializes concurrent updates without losing writes", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update((current) => ({
          count: current.count + 1,
          names: [...current.names, `n${index}`],
        })),
      ),
    );
    const value = await store.read();
    expect(value.count).toBe(20);
    expect(value.names).toHaveLength(20);
  });

  it("rejects a corrupt file instead of silently resetting it", async () => {
    await store.update(() => ({ count: 3, names: [] }));
    await writeFile(store.filePath, "{ not json");
    await expect(store.read()).rejects.toThrow(/not valid JSON/);
    await writeFile(store.filePath, JSON.stringify({ count: "three" }));
    await expect(store.read()).rejects.toThrow(/invalid/);
  });

  it("keeps a failed update from breaking later updates", async () => {
    await expect(
      store.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(store.update(() => ({ count: 5, names: [] }))).resolves.toEqual({
      count: 5,
      names: [],
    });
  });

  it("orders locked reloads and updates so a stale read never wins", async () => {
    await store.update(() => ({ count: 1, names: [] }));
    const applied: number[] = [];
    let releaseReload: () => void = () => {};
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    // A reload that read the file before an update lands must apply before that update.
    const reload = store.locked(async () => {
      const value = await store.read();
      await reloadGate;
      applied.push(value.count);
    });
    const update = store.update(
      () => ({ count: 2, names: [] }),
      (value) => {
        applied.push(value.count);
      },
    );
    releaseReload();
    await Promise.all([reload, update]);
    expect(applied).toEqual([1, 2]);
    expect((await store.read()).count).toBe(2);
  });

  it("notifies on external edits", async () => {
    await store.update(() => ({ count: 1, names: [] }));
    const changed = new Promise<void>((resolve) => {
      const stop = store.watch(() => {
        stop();
        resolve();
      }, 20);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(store.filePath, JSON.stringify({ count: 2 }));
    await changed;
    expect((await store.read()).count).toBe(2);
  });
});
