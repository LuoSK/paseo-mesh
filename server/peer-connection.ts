import type { PaseoApi } from "@getpaseo/client";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostStatus, PeerConfig, PeerSummary } from "../shared/config";
import {
  type ConnectionTarget,
  describeConnection,
  parseConnectionTarget,
} from "./connection-target";
import type { Logger } from "./logger";

export interface ServerIdentity {
  serverId: string;
  hostname: string | null;
  version: string | null;
}

export interface PeerConnectionOptions {
  clientId: string;
  appVersion: string;
  logger: Logger;
  /** Called after every successful (re)connection, with the verified identity. */
  onConnected(peer: PeerConnection): void;
  /** Returns an error when this identity must not be used (self loop, duplicate peer). */
  validateIdentity(peer: PeerConnection, identity: ServerIdentity): string | null;
  connectTimeoutMs?: number;
  retry?: { baseDelayMs: number; maxDelayMs: number };
}

type ConnectionState =
  | { status: "disabled" }
  | { status: "connecting"; attempt: number }
  | { status: "online"; client: DaemonClient; api: PaseoApi; identity: ServerIdentity }
  | { status: "offline"; error: string; attempt: number }
  | { status: "error"; error: string };

export class PeerUnavailableError extends Error {
  constructor(
    readonly peerName: string,
    readonly status: HostStatus,
    detail: string | null,
  ) {
    super(`Host "${peerName}" is ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "PeerUnavailableError";
  }
}

/**
 * Owns one supervised connection to a remote daemon. The SDK client's own reconnect is off:
 * every reconnect builds a fresh client, re-verifies the daemon identity, and notifies the
 * owner so subscriptions and watches are re-established against the new session.
 */
export class PeerConnection {
  private state: ConnectionState = { status: "disabled" };
  private target: ConnectionTarget | null = null;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly waiters = new Set<() => void>();
  private lastIdentity: ServerIdentity | null = null;

  constructor(
    private config: PeerConfig,
    private readonly options: PeerConnectionOptions,
  ) {}

  get id(): string {
    return this.config.id;
  }

  get name(): string {
    return this.config.name;
  }

  get peerConfig(): PeerConfig {
    return this.config;
  }

  get status(): HostStatus {
    return this.state.status;
  }

  /** Last verified identity; survives disconnects so callers can still match by serverId. */
  get identity(): ServerIdentity | null {
    return this.state.status === "online" ? this.state.identity : this.lastIdentity;
  }

  start(): void {
    if (!this.config.enabled) {
      this.setState({ status: "disabled" });
      return;
    }
    try {
      this.target = parseConnectionTarget(this.config.connection);
    } catch (error) {
      this.setState({ status: "error", error: messageOf(error) });
      return;
    }
    void this.connect(1);
  }

  /**
   * Applies a new config. Name, access and path changes apply in place; connection,
   * password and enablement changes reconnect.
   */
  update(next: PeerConfig): void {
    const connectionChanged = next.connection !== this.config.connection;
    const reconnect =
      connectionChanged ||
      next.password !== this.config.password ||
      next.enabled !== this.config.enabled;
    this.config = next;
    if (!reconnect) return;
    if (connectionChanged) this.lastIdentity = null;
    void this.teardown().then(() => this.start());
  }

  /** Reconnect now, skipping any pending backoff. */
  retryNow(): void {
    if (this.state.status === "online" || this.state.status === "connecting") return;
    void this.teardown().then(() => this.start());
  }

  async close(): Promise<void> {
    await this.teardown();
    this.setState({ status: "disabled" });
  }

  /** Resolves the API once online, or throws after `timeoutMs` with the current reason. */
  async api(timeoutMs: number): Promise<PaseoApi> {
    return (await this.session(timeoutMs)).api;
  }

  /** Like `api`, plus the raw client for operations the public SDK lacks (cancel, server wait). */
  async session(timeoutMs: number): Promise<{ api: PaseoApi; daemon: DaemonClient }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.state;
      if (state.status === "online") return { api: state.api, daemon: state.client };
      if (state.status === "disabled" || state.status === "error") {
        throw new PeerUnavailableError(
          this.name,
          state.status,
          "error" in state ? state.error : null,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PeerUnavailableError(
          this.name,
          state.status,
          state.status === "offline" ? state.error : "still connecting",
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.waiters.add(done);
      });
    }
  }

  summary(): PeerSummary {
    const identity = this.identity;
    const state = this.state;
    return {
      id: this.config.id,
      name: this.config.name,
      local: false,
      kind: this.target?.kind ?? (this.config.connection.includes("#offer=") ? "relay" : "direct"),
      endpoint: this.target ? describeConnection(this.target) : "invalid connection",
      access: this.config.access,
      allowedPaths: this.config.allowedPaths,
      enabled: this.config.enabled,
      hasPassword: Boolean(this.config.password),
      status: state.status,
      error: state.status === "offline" || state.status === "error" ? state.error : null,
      serverId: identity?.serverId ?? (this.target?.kind === "relay" ? this.target.serverId : null),
      hostname: identity?.hostname ?? null,
      version: identity?.version ?? null,
    };
  }

  private async connect(attempt: number): Promise<void> {
    const target = this.target;
    if (!target) return;
    const generation = ++this.generation;
    const password =
      this.config.password ?? (target.kind === "relay" ? target.password : undefined);
    this.setState({ status: "connecting", attempt });
    const client = new DaemonClient({
      url: target.url,
      clientId: this.options.clientId,
      clientType: "cli",
      appVersion: this.options.appVersion,
      connectTimeoutMs: this.options.connectTimeoutMs ?? 15_000,
      reconnect: { enabled: false },
      ...(password ? { password } : {}),
      ...(target.kind === "relay"
        ? { e2ee: { enabled: true, daemonPublicKeyB64: target.daemonPublicKeyB64 } }
        : {}),
    });

    let identity: ServerIdentity;
    try {
      await client.connect();
      identity = await readIdentity(client, this.options.connectTimeoutMs ?? 15_000);
    } catch (error) {
      const detail = describeFailure(messageOf(error), client.lastError);
      await client.close().catch(() => {});
      if (generation !== this.generation) return;
      this.scheduleRetry(attempt, detail);
      return;
    }
    if (generation !== this.generation) {
      await client.close().catch(() => {});
      return;
    }

    if (target.kind === "relay" && identity.serverId !== target.serverId) {
      await client.close().catch(() => {});
      this.setState({
        status: "error",
        error: `Daemon reported ${identity.serverId} but the pairing offer is for ${target.serverId}`,
      });
      return;
    }
    if (this.lastIdentity && this.lastIdentity.serverId !== identity.serverId) {
      this.options.logger.warn(
        `Peer ${this.name} now reaches a different daemon (${this.lastIdentity.serverId} -> ${identity.serverId})`,
      );
    }
    const rejection = this.options.validateIdentity(this, identity);
    if (rejection) {
      await client.close().catch(() => {});
      this.lastIdentity = identity;
      this.setState({ status: "error", error: rejection });
      return;
    }

    this.lastIdentity = identity;
    const api = createPaseoApi(client);
    try {
      // The daemon session expects an agent directory fetch before other requests.
      await api.agents.list({ page: { limit: 1 } });
    } catch (error) {
      await api.dispose().catch(() => {});
      await client.close().catch(() => {});
      if (generation !== this.generation) return;
      this.scheduleRetry(attempt, messageOf(error));
      return;
    }
    if (generation !== this.generation) {
      await api.dispose().catch(() => {});
      await client.close().catch(() => {});
      return;
    }
    client.subscribeConnectionStatus((status) => {
      if (generation !== this.generation) return;
      if (status.status === "disconnected" || status.status === "disposed") {
        const reason = "reason" in status && status.reason ? status.reason : "connection lost";
        this.options.logger.warn(`Peer ${this.name} disconnected: ${reason}`);
        void api.dispose().catch(() => {});
        void client.close().catch(() => {});
        this.scheduleRetry(1, reason);
      }
    });
    this.setState({ status: "online", client, api, identity });
    this.options.logger.info(
      `Peer ${this.name} online: ${identity.serverId} (${identity.hostname ?? "unknown host"})`,
    );
    this.options.onConnected(this);
  }

  private scheduleRetry(attempt: number, error: string): void {
    const retry = this.options.retry ?? { baseDelayMs: 1_000, maxDelayMs: 30_000 };
    const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.setState({ status: "offline", error, attempt });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation === this.generation) void this.connect(attempt + 1);
    }, delay);
  }

  private async teardown(): Promise<void> {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const state = this.state;
    if (state.status === "online") {
      await state.api.dispose().catch(() => {});
      await state.client.close().catch(() => {});
    }
    this.setState({ status: "disabled" });
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const wake of [...this.waiters]) {
      this.waiters.delete(wake);
      wake();
    }
  }
}

async function readIdentity(client: DaemonClient, timeoutMs: number): Promise<ServerIdentity> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = client.getLastServerInfoMessage();
    if (info) {
      return {
        serverId: info.serverId,
        hostname: info.hostname ?? null,
        version: info.version ?? null,
      };
    }
    if (Date.now() > deadline) throw new Error("Daemon did not report its identity");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Combines the thrown message with the client's last error without repeating it. */
export function describeFailure(message: string, lastError: string | null): string {
  if (!lastError || message.includes(lastError)) return message;
  if (lastError.includes(message)) return lastError;
  return `${message} (${lastError})`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
