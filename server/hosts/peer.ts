import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostStatus, PeerConfig, PeerSummary } from "../../shared/config";

export type TerminalDaemon = Pick<DaemonClient, "observeTerminal" | "subscribeConnectionStatus">;
export interface TerminalSession {
  api: PaseoApi;
  daemon: TerminalDaemon;
}

export interface ServerIdentity {
  serverId: string;
  hostname: string | null;
  version: string | null;
}

/** Supervised daemon connection used by host resolution and orchestration. */
export interface Peer {
  readonly id: string;
  readonly name: string;
  readonly peerConfig: PeerConfig;
  readonly status: HostStatus;
  readonly claimedServerId: string | null;
  readonly identity: ServerIdentity | null;
  start(): void;
  update(config: PeerConfig): void;
  retryNow(): void;
  close(): Promise<void>;
  summary(): PeerSummary;
  session(timeoutMs: number): Promise<{
    api: PaseoApi;
    daemon: Pick<DaemonClient, "waitForFinish" | "cancelAgent"> & TerminalDaemon;
  }>;
}

export interface PeerLifecycle {
  /** Called after every successful (re)connection, with the verified identity. */
  onConnected(peer: Peer): void;
  /** Returns an error when this identity must not be used (self loop, duplicate peer). */
  validateIdentity(peer: Peer, identity: ServerIdentity): string | null;
}

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
