import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { buildSshTunnelArgs, type SshTransportTarget } from "@getpaseo/protocol/ssh-transport";

const STDERR_LIMIT = 4096;

export interface SshTunnel {
  /** Loopback `host:port` that forwards one WebSocket connection to the remote daemon. */
  endpoint: string;
  /** ssh's own explanation when it failed, e.g. an authentication or host key error. */
  failure(): string | null;
  close(): void;
}

/**
 * Forwards a loopback port to the daemon on an SSH host with `ssh -W`, the way Paseo's CLI and
 * desktop app reach SSH hosts. Uses the daemon user's own SSH configuration, keys and agent;
 * BatchMode makes a missing key fail fast instead of prompting.
 */
export function openSshTunnel(
  target: SshTransportTarget,
  options: { command?: string } = {},
): Promise<SshTunnel> {
  let server: Server | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let socket: Socket | null = null;
  let stderr = "";
  let failure: string | null = null;

  const close = () => {
    server?.close();
    server = null;
    socket?.destroy();
    socket = null;
    if (child && child.exitCode === null) child.kill();
    child = null;
  };

  return new Promise((resolve, reject) => {
    server = createServer((accepted) => {
      // One tunnel carries one daemon connection; reconnects open a new tunnel.
      server?.close();
      server = null;
      socket = accepted;
      child = spawn(options.command ?? "ssh", buildSshTunnelArgs(target), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
      });
      child.on("error", (error) => {
        failure = error.message;
        accepted.destroy();
      });
      child.on("exit", (code, signal) => {
        if (code !== 0 || signal) {
          failure =
            stderr.trim() ||
            (signal ? `ssh exited with ${signal}` : `ssh exited with code ${code}`);
        }
        accepted.destroy();
      });
      accepted.on("error", () => {});
      accepted.on("close", () => {
        if (child && child.exitCode === null) child.kill();
      });
      accepted.pipe(child.stdin);
      child.stdout.pipe(accepted);
    });
    server.once("error", (error) => {
      close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        close();
        reject(new Error("Could not open a local port for the SSH tunnel"));
        return;
      }
      resolve({
        endpoint: `127.0.0.1:${address.port}`,
        failure: () => failure ?? (stderr.trim() || null),
        close,
      });
    });
  });
}
