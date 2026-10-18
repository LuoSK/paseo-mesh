import type { PaseoTerminalHandle } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import type { HostRef } from "./hosts/host-registry";
import { silentLogger } from "./logger";
import { ShellOutput, ShellRunner } from "./shell";

const token = "test-token";
const start = `\x1eMESH_${token}_START\x1f`;
const end = (code: number) => `\x1eMESH_${token}_EXIT:${code}\x1f`;

describe("ShellOutput", () => {
  it("decodes split UTF-8 and protocol frames without changing script output", () => {
    const collector = new ShellOutput(token, 1000);
    const bytes = Buffer.from(
      `echoed handshake\r\n${start}你好🌍\nno trailing newline${end(7)}ignored`,
    );
    for (const byte of bytes) collector.feed(Uint8Array.of(byte));
    collector.flush();
    expect(collector.output).toBe("你好🌍\nno trailing newline");
    expect(collector.exitCode).toBe(7);
    expect(collector.truncated).toBe(false);
  });

  it("drains excessive output and still reads the exit code", () => {
    const collector = new ShellOutput(token, 10);
    collector.feed(Buffer.from(`${start}${"x".repeat(1_000_000)}${end(0)}trailing bytes`));
    collector.flush();
    expect(collector.output).toBe("x".repeat(10));
    expect(collector.truncated).toBe(true);
    expect(collector.exitCode).toBe(0);
  });

  it("retains the last output bytes when a script is interrupted", () => {
    const collector = new ShellOutput(token, 100);
    collector.feed(Buffer.from(`${start}partial`));
    collector.flush();
    expect(collector.output).toBe("partial");
    expect(collector.exitCode).toBeNull();
  });
});

describe("ShellRunner creation cleanup", () => {
  function setup() {
    let resolve!: (terminal: PaseoTerminalHandle) => void;
    const creating = new Promise<PaseoTerminalHandle>((done) => {
      resolve = done;
    });
    const create = vi.fn(() => creating);
    const kill = vi.fn(async () => {});
    const terminal = { id: "temporary", kill } as unknown as PaseoTerminalHandle;
    const api = {
      workspaces: { open: async () => ({ terminals: { create } }) },
      terminals: { ref: () => terminal },
    };
    const directory = {
      api: async () => api,
      terminalSession: async () => ({ api, daemon: { subscribeConnectionStatus: () => () => {} } }),
    } as unknown as ConstructorParameters<typeof ShellRunner>[0];
    const runner = new ShellRunner(directory, "test", silentLogger);
    const abort = new AbortController();
    const host: HostRef = {
      kind: "local",
      id: "local",
      name: "local",
      access: "write",
      allowExec: true,
      allowedPaths: [],
      serverId: "local-id",
    };
    const pending = runner.execute(
      host,
      {
        cwd: "/tmp",
        script: "true",
        shell: "/bin/sh",
        timeoutSeconds: 50,
        maxOutputChars: 100,
      },
      abort.signal,
    );
    return { runner, abort, create, resolve, terminal, kill, pending };
  }

  it("cleans a creation response that arrives after cancellation", async () => {
    const fixture = setup();
    await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledOnce());
    fixture.abort.abort();
    expect(await fixture.pending).toMatchObject({ cleanupPending: true });
    fixture.resolve(fixture.terminal);
    await vi.waitFor(() => expect(fixture.kill).toHaveBeenCalledOnce());
    await fixture.runner.close();
  });

  it("retains the terminal handle when creation and cancellation settle together", async () => {
    const fixture = setup();
    await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledOnce());
    fixture.resolve(fixture.terminal);
    fixture.abort.abort();
    expect(await fixture.pending).toMatchObject({ cleanupPending: false });
    expect(fixture.kill).toHaveBeenCalledOnce();
    await fixture.runner.close();
  });
});
