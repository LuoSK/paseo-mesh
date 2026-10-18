import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellResult } from "../../server/shell";
import { shellWrapper } from "../../server/shell";
import { callTool, callToolError, ROOT, TestDaemon, tempDir, waitFor } from "./harness";

let local: TestDaemon;
let remote: TestDaemon;
let client: McpClient;
let cwd: string;
let peerId: string;

beforeAll(async () => {
  cwd = tempDir("shell-work");
  [local, remote] = await Promise.all([
    TestDaemon.start({ name: "shell-local", plugins: [ROOT] }),
    TestDaemon.start({
      name: "shell-remote",
      plugins: [],
      relay: process.env.MESH_E2E_RELAY === "1",
    }),
  ]);
  await local.waitForMesh();
  const peer = await local.rpc<{ id: string }>("mesh.peers.add", {
    name: "remote",
    connection: remote.endpoint,
    access: "write",
    allowExec: true,
  });
  peerId = peer.id;
  client = await local.mcp();
});

afterAll(async () => {
  await client?.close().catch(() => {});
  await Promise.all([local?.destroy(), remote?.destroy()]);
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function exec(script: string, extra: Record<string, unknown> = {}) {
  return callTool<ShellResult>(client, "mesh_exec", { host: "remote", cwd, script, ...extra });
}

async function terminals() {
  return (await (await remote.api()).terminals.list()).entries;
}

async function noTerminals() {
  await waitFor(async () => (await terminals()).length === 0, { timeoutMs: 10_000 });
}

async function request(script: string, signal?: AbortSignal) {
  const server = await local.meshServer();
  return fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 991,
      method: "tools/call",
      params: {
        name: "mesh_exec",
        arguments: { host: "remote", cwd, script, timeoutSeconds: 30 },
      },
    }),
    signal: signal as NonNullable<Parameters<typeof fetch>[1]>["signal"],
  });
}

describe("mesh_exec", () => {
  it("returns exact combined output and nonzero status from a plain remote daemon", async () => {
    const result = await exec(
      "printf '你好🌍\\n'; printf 'error\\n' >&2; printf '%s' \"$PWD\"; exit 7",
    );
    expect(result).toMatchObject({
      output: `你好🌍\nerror\n${cwd}`,
      exitCode: 7,
      timedOut: false,
      truncated: false,
      error: null,
      cleanupPending: false,
    });
    await noTerminals();
  });

  it.skipIf(process.env.MESH_E2E_RELAY !== "1")(
    "returns script output over the encrypted relay",
    async () => {
      const offer = await (await remote.client()).getDaemonPairingOffer();
      expect(offer.relayEnabled).toBe(true);
      try {
        await local.rpc("mesh.peers.update", { id: peerId, connection: offer.url });
        const result = await exec("printf 'relay output\\n'; exit 3");
        expect(result).toMatchObject({
          output: "relay output\n",
          exitCode: 3,
          error: null,
          cleanupPending: false,
        });
        await noTerminals();
      } finally {
        await local.rpc("mesh.peers.update", { id: peerId, connection: remote.endpoint });
      }
    },
  );

  it("supports empty output, multiline scripts, shell selection and missing executables", async () => {
    expect(await exec("exit 0")).toMatchObject({ output: "", exitCode: 0, error: null });
    expect(
      await exec(`items=(one two)\nprintf '%s\\n' "\${items[@]}"`, { shell: "/bin/bash" }),
    ).toMatchObject({ output: "one\ntwo\n", exitCode: 0, error: null });
    expect(await exec("true", { shell: "/nonexistent/mesh-shell" })).toMatchObject({
      exitCode: 127,
      error: null,
    });
    expect(await exec("read -r item; printf 'input=%s' \"$?\"")).toMatchObject({
      output: "input=1",
      exitCode: 0,
      error: null,
    });
    await noTerminals();
  });

  it("captures output beyond terminal scrollback and bounds the returned result", async () => {
    const script = "awk 'BEGIN { for (i=0; i<12000; i++) print \"line-\" i }'";
    const result = await exec(script);
    expect(result.error).toBeNull();
    expect(result.output).toBe(Array.from({ length: 12000 }, (_, i) => `line-${i}\n`).join(""));
    expect(await exec(script, { maxOutputChars: 13 })).toMatchObject({
      output: "line-0\nline-1",
      exitCode: 0,
      truncated: true,
      error: null,
    });
    await noTerminals();
  });

  it("runs repeatedly and concurrently without accumulating terminals", async () => {
    for (let i = 0; i < 20; i++) expect((await exec(`printf ${i}`)).output).toBe(String(i));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => exec(`printf ${i}`)));
    expect(results.map((result) => result.output)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    expect(results.every((result) => !result.error && !result.cleanupPending)).toBe(true);
    await noTerminals();
  });

  it("enforces the shell opt-in, write access and initial allowed directory", async () => {
    try {
      await local.rpc("mesh.peers.update", { id: peerId, allowExec: false });
      expect(
        await callToolError(client, "mesh_exec", { host: "remote", cwd, script: "true" }),
      ).toContain("disabled");
      await local.rpc("mesh.peers.update", { id: peerId, allowExec: true, access: "read" });
      expect(
        await callToolError(client, "mesh_exec", { host: "remote", cwd, script: "true" }),
      ).toContain("read-only");
      await local.rpc("mesh.peers.update", {
        id: peerId,
        access: "write",
        allowedPaths: [path.join(cwd, "allowed")],
      });
      expect(
        await callToolError(client, "mesh_exec", { host: "remote", cwd, script: "true" }),
      ).toContain("outside");
    } finally {
      await local.rpc("mesh.peers.update", {
        id: peerId,
        access: "write",
        allowExec: true,
        allowedPaths: [],
      });
    }
    await noTerminals();
  });

  it("returns partial output on timeout and cleans the terminal and child processes", async () => {
    const pidFile = path.join(cwd, "timeout.pid");
    const result = await exec(
      `sleep 60 &\nprintf '%s' "$!" > '${pidFile}'\nprintf 'started\\n'\nwait`,
      { timeoutSeconds: 1 },
    );
    expect(result).toMatchObject({
      output: "started\n",
      exitCode: null,
      timedOut: true,
      cleanupPending: false,
    });
    expect(result.error).toContain("timed out");
    await noTerminals();
    const pid = Number(await readFile(pidFile, "utf8"));
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { timeoutMs: 5000, message: "Timed-out child survived cleanup" },
    );
  });

  it("cleans up when the HTTP caller disconnects", async () => {
    const abort = new AbortController();
    const pending = request("printf 'running\\n'; sleep 60", abort.signal).catch(() => null);
    await waitFor(async () => (await terminals()).length === 1);
    abort.abort();
    await pending;
    await noTerminals();
  });

  it("handles MCP cancellation notifications and returns partial output", async () => {
    const pending = request("printf 'running\\n'; sleep 60").then((response) => response.json());
    await waitFor(async () => (await terminals()).length === 1);
    const server = await local.meshServer();
    const cancelled = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 991 },
      }),
    });
    expect(cancelled.status).toBe(202);
    const response = (await pending) as { result: { structuredContent: ShellResult } };
    expect(response.result.structuredContent.error).toContain("cancelled");
    expect(response.result.structuredContent.cleanupPending).toBe(false);
    await noTerminals();
  });

  it("reaps terminals on reconnect and never replays an interrupted script", async () => {
    const marker = path.join(cwd, "reconnect-marker");
    const pending = exec(`printf x >> '${marker}'; sleep 60`);
    await waitFor(async () => (await readFile(marker, "utf8")) === "x");
    await local.rpc("mesh.peers.update", { id: peerId, enabled: false });
    const result = await pending;
    expect(result.error).toContain("disconnected");
    expect(result.cleanupPending).toBe(true);
    await local.rpc("mesh.peers.update", { id: peerId, enabled: true });
    await noTerminals();
    expect(await readFile(marker, "utf8")).toBe("x");
    expect(await exec("printf connected")).toMatchObject({
      output: "connected",
      exitCode: 0,
      error: null,
    });
  });

  it("expires orphaned terminals even without a mesh connection", async () => {
    const workspace = await (await remote.api()).workspaces.open(cwd);
    const terminal = await workspace.terminals.create({
      name: "watchdog-proof",
      command: "/bin/sh",
      args: ["-c", shellWrapper(), "mesh-exec", "/bin/sh", "printf unused", "1", "watchdog-token"],
    });
    try {
      await waitFor(async () => !(await terminals()).some((entry) => entry.id === terminal.id), {
        timeoutMs: 5000,
      });
    } finally {
      await terminal.kill();
    }
    await noTerminals();
  });

  it("supports local execution with separate opt-in", async () => {
    await local.rpc("mesh.settings.update", { localAllowExec: true });
    try {
      const result = await exec("printf local", { host: "local" });
      expect(result).toMatchObject({
        output: "local",
        exitCode: 0,
        error: null,
        cleanupPending: false,
      });
      expect((await (await local.api()).terminals.list()).entries).toEqual([]);
    } finally {
      await local.rpc("mesh.settings.update", { localAllowExec: false });
    }
  });

  it("cleans running executions when the plugin reloads", async () => {
    const pending = request("sleep 60")
      .then((response) => response.text())
      .catch(() => null);
    await waitFor(async () => (await terminals()).length === 1);
    await local.reloadPlugin("mesh");
    await pending;
    await noTerminals();
    await client.close();
    client = await local.mcp();
    expect(await exec("printf reloaded")).toMatchObject({
      output: "reloaded",
      exitCode: 0,
      error: null,
    });
  });

  it("recovers abandoned terminals after reload and preserves user terminals", async () => {
    const owner = `${local.serverId}:${local.meshDataDir()}`;
    const prefix = `paseo-mesh-exec-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}-`;
    const workspace = await (await remote.api()).workspaces.open(cwd);
    const stale = await workspace.terminals.create({
      name: `${prefix}abandoned`,
      command: "/bin/sh",
      args: ["-c", "sleep 60"],
    });
    const user = await workspace.terminals.create({ name: "user terminal", command: "/bin/sh" });
    try {
      await local.reloadPlugin("mesh");
      await waitFor(async () => !(await terminals()).some((terminal) => terminal.id === stale.id));
      expect((await terminals()).some((terminal) => terminal.id === user.id)).toBe(true);
    } finally {
      await stale.kill();
      await user.kill();
      await client.close();
      client = await local.mcp();
    }
    await noTerminals();
  });
});
