import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Logger } from "./logger";
import { messageOf } from "./peer-connection";

/**
 * The plugin's view of its own daemon.
 *
 * Paseo hands plugin code a PaseoApi only inside hook and RPC calls. Tools called by agents
 * and notifications for finished remote work can happen before any such call (for example
 * right after a plugin reload), so this falls back to connecting to the daemon the way the
 * CLI does: the listen address from `$PASEO_HOME/paseo.pid` and the owner-only
 * `$PASEO_HOME/local-credential`.
 */
export class LocalConnection {
  private provided: PaseoApi | null = null;
  private own: { client: DaemonClient; api: PaseoApi } | null = null;
  private connecting: Promise<PaseoApi> | null = null;

  constructor(
    private readonly options: {
      paseoHome: string | null;
      clientId: string;
      appVersion: string;
      logger: Logger;
    },
  ) {}

  provide(api: PaseoApi): void {
    this.provided ??= api;
  }

  async api(): Promise<PaseoApi> {
    if (this.provided) return this.provided;
    if (this.own) return this.own.api;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async close(): Promise<void> {
    const own = this.own;
    this.own = null;
    if (!own) return;
    await own.api.dispose().catch(() => {});
    await own.client.close().catch(() => {});
  }

  private async connect(): Promise<PaseoApi> {
    const home = this.options.paseoHome;
    if (!home) throw new Error("PASEO_HOME is not set; cannot reach the local daemon");
    let listen: string;
    try {
      const pid = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8")) as {
        listen?: string;
      };
      if (!pid.listen) throw new Error("no listen address recorded");
      listen = pid.listen;
    } catch (error) {
      throw new Error(`Cannot find the local daemon address: ${messageOf(error)}`);
    }
    const url = localWebSocketUrl(listen);
    const credentialPath = path.join(home, "local-credential");
    const client = new DaemonClient({
      url,
      clientId: this.options.clientId,
      clientType: "cli",
      appVersion: this.options.appVersion,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 5_000 },
      localCredential: async () => {
        try {
          return (await readFile(credentialPath, "utf8")).trim() || undefined;
        } catch {
          return undefined;
        }
      },
    });
    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(`Cannot connect to the local daemon at ${listen}: ${messageOf(error)}`);
    }
    const api = createPaseoApi(client);
    // The daemon session expects an agent directory fetch before other requests.
    await api.agents.list({ page: { limit: 1 } });
    this.own = { client, api };
    this.options.logger.info(`Connected to the local daemon at ${listen}`);
    return api;
  }
}

/** Turns a daemon listen value into a loopback WebSocket URL. */
export function localWebSocketUrl(listen: string): string {
  const value = listen.trim();
  if (value.startsWith("/") || value.startsWith("unix://") || value.startsWith("\\\\")) {
    throw new Error(
      `The daemon listens on a socket (${value}); paseo-mesh needs a TCP listen address to reach it outside hooks`,
    );
  }
  const match = /^(.*):(\d+)$/.exec(value);
  if (!match) throw new Error(`Unrecognized listen address: ${value}`);
  let host = match[1] ?? "";
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "[::]") host = "127.0.0.1";
  return `ws://${host}:${match[2]}/ws`;
}
