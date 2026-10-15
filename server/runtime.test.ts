import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "./logger";
import { MeshRuntime } from "./runtime";

describe("MeshRuntime lifecycle", () => {
  let dir: string;
  let runtime: MeshRuntime;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mesh-runtime-"));
    runtime = new MeshRuntime({ dataDirectory: dir, paseoHome: dir, logger: silentLogger });
  });
  afterEach(async () => {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("starts once and releases the MCP endpoint when stopped", async () => {
    expect(runtime.start()).toBe(runtime.start());
    await runtime.ready;
    const url = (await runtime.status()).mcp.url;
    expect(url).not.toBeNull();
    expect((await fetch(new URL("/health", url ?? ""))).ok).toBe(true);
    await runtime.stop();
    expect((await runtime.status()).mcp.url).toBeNull();
    await expect(fetch(new URL("/health", url ?? ""))).rejects.toThrow();
  });

  it("waits for an in-flight start before closing its resources", async () => {
    const starting = runtime.start();
    await runtime.stop();
    await starting;
    expect((await runtime.status()).mcp.url).toBeNull();
    expect(runtime.registry.remotePeers()).toEqual([]);
  });

  it("stays stopped when closed before initialization", async () => {
    await runtime.stop();
    await runtime.start();
    await runtime.ready;
    expect((await runtime.status()).mcp.url).toBeNull();
  });
});
