import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { LOCAL_HOST_NAME, meshConfigSchema, type PeerSummary } from "../shared/config";
import {
  addPeerRpc,
  describeSelfRpc,
  listMeshAgentsRpc,
  meshStatusRpc,
  removePeerRpc,
  retryPeerRpc,
  syncPeersRpc,
  updatePeerRpc,
  updateSettingsRpc,
} from "../shared/rpc";
import { MESH_VERSION, PASEO_CLIENT_APP_VERSION } from "../shared/version";
import { listAgents } from "./agents/queries";
import { WatchManager, watchFileSchema } from "./agents/watches";
import { messageOf } from "./errors";
import { ADD_HOST_GUIDANCE, HostRegistry } from "./hosts/host-registry";
import { LocalConnection } from "./hosts/local-connection";
import { PeerConnection } from "./hosts/peer-connection";
import { consoleLogger, type Logger } from "./logger";
import { CALLER_ENV, CallerRegistry, callerFileSchema } from "./mcp/callers";
import { type McpHttpServer, startMcpHttpServer } from "./mcp/http";
import { createMeshTools, READ_ONLY_TOOL_NAMES } from "./mcp/tools";
import { JsonFileStore } from "./state/json-store";
import { MeshSettings } from "./state/settings";

export const MCP_SERVER_NAME = "mesh";

const serverStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(16),
});
type ServerState = z.infer<typeof serverStateSchema>;

export interface MeshRuntimeOptions {
  /** Directory for mesh state. Defaults to $PASEO_MESH_HOME or $PASEO_HOME/paseo-mesh. */
  dataDirectory?: string;
  paseoHome?: string;
  logger?: Logger;
  retry?: { baseDelayMs: number; maxDelayMs: number };
  watch?: { waitChunkMs?: number; retryDelayMs?: number; orphanTtlMs?: number };
}

/**
 * Composes daemon services and registers RPCs and hooks. `contribute` registers synchronously
 * and calls `start` without awaiting it; RPC handlers and hooks wait on `ready`.
 */
export class MeshRuntime {
  readonly dataDirectory: string;
  private readonly paseoHome: string | null;
  private readonly logger: Logger;
  private readonly settings: MeshSettings;
  private readonly serverStore: JsonFileStore<ServerState | null>;
  private readonly callers: CallerRegistry;
  readonly registry: HostRegistry;
  readonly watches: WatchManager;
  private mcp: McpHttpServer | null = null;
  private mcpError: string | null = null;
  private token: string | null = null;
  private readonly local: LocalConnection;
  private localServerId: string | null = null;
  private localHostname: string;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;

  constructor(options: MeshRuntimeOptions = {}) {
    this.paseoHome = options.paseoHome ?? process.env.PASEO_HOME ?? null;
    this.dataDirectory =
      options.dataDirectory ??
      process.env.PASEO_MESH_HOME ??
      path.join(this.paseoHome ?? path.join(os.homedir(), ".paseo"), "paseo-mesh");
    this.logger = options.logger ?? consoleLogger;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.serverStore = new JsonFileStore(
      path.join(this.dataDirectory, "server.json"),
      serverStateSchema.nullable(),
      () => null,
    );
    this.callers = new CallerRegistry(
      new JsonFileStore(path.join(this.dataDirectory, "callers.json"), callerFileSchema, () =>
        callerFileSchema.parse({}),
      ),
    );
    this.localServerId = readLocalServerId(this.paseoHome);
    this.localHostname = readLocalHostname(this.paseoHome) ?? os.hostname();
    this.local = new LocalConnection({
      paseoHome: this.paseoHome,
      clientId: `paseo-mesh-local:${this.localServerId ?? "unknown"}`,
      appVersion: PASEO_CLIENT_APP_VERSION,
      logger: this.logger,
    });
    this.registry = new HostRegistry({
      logger: this.logger,
      createPeer: (config, lifecycle) =>
        new PeerConnection(config, {
          clientId: `paseo-mesh:${this.localServerId ?? "unknown"}:${config.id}`,
          appVersion: PASEO_CLIENT_APP_VERSION,
          logger: this.logger,
          retry: options.retry,
          ...(process.env.PASEO_MESH_SSH_COMMAND
            ? { sshCommand: process.env.PASEO_MESH_SSH_COMMAND }
            : {}),
          ...lifecycle,
        }),
      localApi: () => this.local.api(),
      localServerId: () => this.localServerId,
      localHostname: () => this.localHostname,
      localVersion: () => null,
      onPeerConnected: () => this.watches.poke(),
    });
    this.watches = new WatchManager({
      store: new JsonFileStore(path.join(this.dataDirectory, "watches.json"), watchFileSchema, () =>
        watchFileSchema.parse({}),
      ),
      registry: this.registry,
      localApi: () => this.local.api(),
      logger: this.logger,
      ...options.watch,
    });
    this.settings = new MeshSettings({
      store: new JsonFileStore(path.join(this.dataDirectory, "config.json"), meshConfigSchema, () =>
        meshConfigSchema.parse({}),
      ),
      logger: this.logger,
      localServerId: () => this.localServerId,
      peerServerId: (id) => this.registry.peerById(id)?.identity?.serverId,
      onApply: (config) => {
        this.registry.apply(config);
        this.watches.poke();
      },
    });
  }

  /** Registers RPCs and hooks. Must run synchronously inside `contribute`. */
  register(server: PluginServerContext): void {
    server.handle(meshStatusRpc, async (_input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return this.status();
    });
    server.handle(addPeerRpc, async (input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return this.requirePeerSummary(await this.settings.addPeer(input));
    });
    server.handle(updatePeerRpc, async (input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return this.requirePeerSummary(await this.settings.updatePeer(input));
    });
    server.handle(removePeerRpc, async ({ id }, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return { removed: await this.settings.removePeer(id) };
    });
    server.handle(retryPeerRpc, async ({ id }, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      const peer = this.registry.peerById(id);
      if (!peer) throw new Error(`Unknown peer ${id}`);
      peer.retryNow();
      return peer.summary();
    });
    server.handle(updateSettingsRpc, async (input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      const next = await this.settings.update(input);
      return { localAccess: next.localAccess, injection: next.injection };
    });
    server.handle(describeSelfRpc, async (_input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      let offerUrl: string | null = null;
      try {
        offerUrl = await this.local.pairingOffer();
      } catch (error) {
        this.logger.warn(`Could not read this daemon's pairing offer: ${messageOf(error)}`);
      }
      return {
        serverId: this.localServerId,
        hostname: this.localHostname,
        offerUrl,
        appSyncEnabled: this.settings.current.appSync.enabled,
      };
    });
    server.handle(syncPeersRpc, async (input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return this.settings.syncPeers(input);
    });
    server.handle(listMeshAgentsRpc, async (input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return listAgents(this.registry, { includeArchived: input.includeArchived, limit: 100 });
    });

    server.before("agent.create", async ({ request }, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      const injection = this.settings.current.injection;
      if (!injection.enabled || !this.mcp || !this.token) return undefined;
      if (injection.excludeProviders.includes(request.config.provider)) return undefined;
      const existing = request.config.mcpServers?.[MCP_SERVER_NAME];
      // A config copied from another agent (schedules, forks) carries that agent's caller
      // nonce; replace it so the new agent gets its own identity. Leave a foreign "mesh"
      // server that is not ours alone.
      if (existing && !(existing.type === "http" && isMeshUrl(existing.url, this.mcp.url))) {
        return undefined;
      }
      const nonce = await this.callers.issue();
      const preapproved =
        injection.preapproveReadOnlyTools &&
        injection.preapproveProviders.includes(request.config.provider)
          ? READ_ONLY_TOOL_NAMES.map((tool) => ({
              kind: "mcp" as const,
              server: MCP_SERVER_NAME,
              tool,
            }))
          : [];
      const existingPolicy = (request.config.toolPolicy?.preapproved ?? []).filter(
        (grant) => grant.server !== MCP_SERVER_NAME,
      );
      return {
        ...request,
        config: {
          ...request.config,
          mcpServers: {
            ...request.config.mcpServers,
            [MCP_SERVER_NAME]: {
              type: "http",
              url: `${this.mcp.url}?caller=${nonce}`,
              headers: { Authorization: `Bearer ${this.token}` },
            },
          },
          ...(preapproved.length > 0 || request.config.toolPolicy
            ? { toolPolicy: { preapproved: [...existingPolicy, ...preapproved] } }
            : {}),
        },
        env: { ...request.env, [CALLER_ENV]: nonce },
      };
    });

    server.before("agent.session_open", async ({ request }, { paseo }) => {
      this.provideLocalApi(paseo);
      const nonce = request.env[CALLER_ENV];
      if (!nonce) return undefined;
      await this.ready;
      await this.callers.bind(nonce, request.agentId);
      return undefined;
    });

    // Any hook or handler call brings the IPC-backed API; capture it as early as possible.
    server.on("agent.created", (_event, { paseo }) => this.provideLocalApi(paseo));
  }

  start(): Promise<void> {
    if (this.stopTask) return Promise.resolve();
    this.startTask ??= this.initialize();
    return this.startTask;
  }

  private async initialize(): Promise<void> {
    try {
      await this.callers.load().catch((error) => {
        this.logger.error(`Could not load callers: ${messageOf(error)}`);
      });
      await this.settings.start();
      await this.startMcp();
      await this.watches.start();
      this.logger.info(
        `paseo-mesh ${MESH_VERSION} ready: ${this.settings.current.peers.length} peer(s), data in ${this.dataDirectory}`,
      );
    } catch (error) {
      this.logger.error(`paseo-mesh failed to start: ${messageOf(error)}`);
    } finally {
      this.resolveReady();
    }
  }

  stop(): Promise<void> {
    this.stopTask ??= this.shutdown();
    return this.stopTask;
  }

  private async shutdown(): Promise<void> {
    await this.startTask;
    this.resolveReady();
    await this.settings.close();
    await this.watches.close();
    await this.registry.close();
    await this.mcp?.close();
    this.mcp = null;
    await this.local.close();
  }

  tools() {
    return createMeshTools({
      registry: this.registry,
      watches: this.watches,
      resolveCaller: (caller) => this.callers.resolve(caller),
      localServerId: () => this.localServerId,
      localHostname: () => this.localHostname,
    });
  }

  async status() {
    const watches = await this.watches.list().catch(() => []);
    return {
      version: MESH_VERSION,
      hosts: this.registry.summaries(),
      localAccess: this.settings.current.localAccess,
      injection: this.settings.current.injection,
      appSync: { ...this.settings.current.appSync, last: this.settings.lastSync },
      mcp: { url: this.mcp?.url ?? null, error: this.mcpError },
      dataDirectory: this.dataDirectory,
      configError: this.settings.error,
      watches: watches.length,
    };
  }

  provideLocalApi(api: PaseoApi): void {
    this.local.provide(api);
  }

  private requirePeerSummary(id: string): PeerSummary {
    const peer = this.registry.peerById(id);
    if (!peer) throw new Error(`Unknown peer ${id}`);
    return peer.summary();
  }

  private async startMcp(): Promise<void> {
    const saved = await this.serverStore.read().catch(() => null);
    const token = saved?.token ?? randomBytes(24).toString("hex");
    const preferredPort = saved?.port ?? defaultPort(this.paseoHome ?? this.dataDirectory);
    const options = {
      name: "paseo-mesh",
      version: MESH_VERSION,
      token,
      instructions: MCP_INSTRUCTIONS,
      tools: () => this.cachedTools(),
      onError: (error: unknown) => this.logger.error(`MCP request failed: ${messageOf(error)}`),
    };
    try {
      this.mcp = await startMcpHttpServer(options, { host: "127.0.0.1", port: preferredPort });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        this.mcpError = messageOf(error);
        this.logger.error(`MCP server failed to start: ${this.mcpError}`);
        return;
      }
      this.logger.warn(
        `Port ${preferredPort} is in use; agents created earlier lose mesh tools until refreshed onto the new port`,
      );
      this.mcp = await startMcpHttpServer(options, { host: "127.0.0.1", port: 0 });
    }
    this.token = token;
    if (saved?.port !== this.mcp.port || saved?.token !== token) {
      await this.serverStore.update(() => ({ port: this.mcp?.port ?? preferredPort, token }));
    }
    this.logger.info(`MCP server listening on ${this.mcp.url}`);
  }

  private toolCache: ReturnType<MeshRuntime["tools"]> | null = null;
  private cachedTools() {
    this.toolCache ??= this.tools();
    return this.toolCache;
  }
}

export const MCP_INSTRUCTIONS = `paseo-mesh connects this agent to other Paseo hosts (daemons on other machines).
Use mesh_list_hosts first. Identify agents by (host, agentId); "${LOCAL_HOST_NAME}" is this machine.
${ADD_HOST_GUIDANCE}
Paths, providers and models always refer to the host you name. Files are not shared between hosts: hand work over through git or messages.
When you create or prompt an agent with notifyOnFinish (default), you receive a message when it finishes, errors or needs permission. Do not poll.
Messages that start with "[paseo-mesh] Message from agent ..." come from an agent on another host. Answer them with mesh_send_prompt using the host and agentId the header names, with notifyOnFinish false unless you need the sender's next result.`;

/** True for this plugin's MCP endpoint, on its current or any earlier loopback port. */
function isMeshUrl(url: string, current: string): boolean {
  try {
    const parsed = new URL(url);
    const ours = new URL(current);
    return (
      parsed.hostname === ours.hostname &&
      parsed.pathname === ours.pathname &&
      parsed.searchParams.has("caller")
    );
  } catch {
    return false;
  }
}

/** The daemon's own display name, as peers see it in server_info. */
function readLocalHostname(paseoHome: string | null): string | null {
  if (!paseoHome) return null;
  try {
    const pid = JSON.parse(readFileSync(path.join(paseoHome, "paseo.pid"), "utf8")) as {
      hostname?: unknown;
    };
    return typeof pid.hostname === "string" && pid.hostname ? pid.hostname : null;
  } catch {
    return null;
  }
}

function readLocalServerId(paseoHome: string | null): string | null {
  if (!paseoHome) return null;
  try {
    return readFileSync(path.join(paseoHome, "server-id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Stable per-home port so the URL persisted in agent configs survives restarts. */
export function defaultPort(seed: string): number {
  const hash = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return 41_000 + (hash % 8_000);
}
