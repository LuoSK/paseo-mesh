import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  LOCAL_HOST_NAME,
  type MeshConfig,
  meshConfigSchema,
  newPeerId,
  type PeerConfig,
  type PeerSummary,
} from "../shared/config";
import {
  addPeerRpc,
  listMeshAgentsRpc,
  meshStatusRpc,
  removePeerRpc,
  retryPeerRpc,
  updatePeerRpc,
  updateSettingsRpc,
} from "../shared/rpc";
import { MESH_VERSION, PASEO_CLIENT_APP_VERSION } from "../shared/version";
import { CALLER_ENV, CallerRegistry, callerFileSchema } from "./callers";
import { parseConnectionTarget } from "./connection-target";
import { HostRegistry } from "./host-registry";
import { JsonFileStore } from "./json-store";
import { LocalConnection } from "./local-connection";
import { consoleLogger, type Logger } from "./logger";
import { type McpHttpServer, startMcpHttpServer } from "./mcp-http";
import { messageOf } from "./peer-connection";
import { createMeshTools, READ_ONLY_TOOL_NAMES } from "./tools";
import { WatchManager, watchFileSchema } from "./watches";

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
 * Everything the plugin does on the daemon host. `contribute` registers synchronously and
 * calls `start` without awaiting it; RPC handlers and hooks wait on `ready`.
 */
export class MeshRuntime {
  readonly dataDirectory: string;
  private readonly paseoHome: string | null;
  private readonly logger: Logger;
  private readonly configStore: JsonFileStore<MeshConfig>;
  private readonly serverStore: JsonFileStore<ServerState>;
  private readonly callers: CallerRegistry;
  readonly registry: HostRegistry;
  readonly watches: WatchManager;
  private config: MeshConfig = meshConfigSchema.parse({});
  private configError: string | null = null;
  private mcp: McpHttpServer | null = null;
  private mcpError: string | null = null;
  private token: string | null = null;
  private readonly local: LocalConnection;
  private stopWatchingConfig: (() => void) | null = null;
  private localServerId: string | null = null;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;

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
    this.configStore = new JsonFileStore(
      path.join(this.dataDirectory, "config.json"),
      meshConfigSchema,
      () => meshConfigSchema.parse({}),
    );
    this.serverStore = new JsonFileStore(
      path.join(this.dataDirectory, "server.json"),
      serverStateSchema.nullable(),
      () => null,
    ) as unknown as JsonFileStore<ServerState>;
    this.callers = new CallerRegistry(
      new JsonFileStore(path.join(this.dataDirectory, "callers.json"), callerFileSchema, () =>
        callerFileSchema.parse({}),
      ),
    );
    this.localServerId = readLocalServerId(this.paseoHome);
    this.local = new LocalConnection({
      paseoHome: this.paseoHome,
      clientId: `paseo-mesh-local:${this.localServerId ?? "unknown"}`,
      appVersion: PASEO_CLIENT_APP_VERSION,
      logger: this.logger,
    });
    this.registry = new HostRegistry({
      logger: this.logger,
      clientId: `paseo-mesh:${this.localServerId ?? "unknown"}`,
      appVersion: PASEO_CLIENT_APP_VERSION,
      localApi: () => this.local.api(),
      localServerId: () => this.localServerId,
      localHostname: () => os.hostname(),
      localVersion: () => null,
      onPeerConnected: () => this.watches.poke(),
      retry: options.retry,
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
      return this.addPeer(input);
    });
    server.handle(updatePeerRpc, async (input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return this.updatePeer(input);
    });
    server.handle(removePeerRpc, async ({ id }, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      return { removed: await this.removePeer(id) };
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
      const next = await this.mutateConfig((config) => ({
        ...config,
        ...(input.localAccess ? { localAccess: input.localAccess } : {}),
        ...(input.injection ? { injection: { ...config.injection, ...input.injection } } : {}),
      }));
      return { localAccess: next.localAccess, injection: next.injection };
    });
    server.handle(listMeshAgentsRpc, async (input, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      const listAgents = this.tools().find((tool) => tool.name === "mesh_list_agents");
      const result = await listAgents?.call(
        { includeArchived: input.includeArchived, limit: 100 },
        { caller: { nonce: null }, signal: new AbortController().signal },
      );
      if (!result || result.isError) {
        throw new Error(result?.content[0]?.text ?? "Listing agents failed");
      }
      const data = result.structuredContent as {
        agents: Array<Record<string, unknown>>;
        unreachable: Array<{ host: string; error: string }>;
      };
      return {
        agents: data.agents.map((agent) => ({
          host: String(agent.host),
          serverId: (agent.serverId as string | null) ?? null,
          agentId: String(agent.agentId),
          title: (agent.title as string | null) ?? null,
          status: String(agent.status),
          provider: String(agent.provider),
          cwd: String(agent.cwd),
          requiresAttention: Boolean(agent.requiresAttention),
          attentionReason: (agent.attentionReason as string | null) ?? null,
          updatedAt: (agent.updatedAt as string | null) ?? null,
          archivedAt: (agent.archivedAt as string | null) ?? null,
        })),
        unreachable: data.unreachable,
      };
    });

    server.before("agent.create", async ({ request }, { paseo }) => {
      this.provideLocalApi(paseo);
      await this.ready;
      const injection = this.config.injection;
      if (!injection.enabled || !this.mcp || !this.token) return undefined;
      if (injection.excludeProviders.includes(request.config.provider)) return undefined;
      if (request.config.mcpServers?.[MCP_SERVER_NAME]) return undefined;
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
      const existingPolicy = request.config.toolPolicy?.preapproved ?? [];
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

  async start(): Promise<void> {
    try {
      await this.callers.load().catch((error) => {
        this.logger.error(`Could not load callers: ${messageOf(error)}`);
      });
      await this.reloadConfig();
      this.stopWatchingConfig = this.configStore.watch(() => void this.reloadConfig());
      await this.startMcp();
      await this.watches.start();
      this.logger.info(
        `paseo-mesh ${MESH_VERSION} ready: ${this.config.peers.length} peer(s), data in ${this.dataDirectory}`,
      );
    } catch (error) {
      this.logger.error(`paseo-mesh failed to start: ${messageOf(error)}`);
    } finally {
      this.resolveReady();
    }
  }

  async stop(): Promise<void> {
    this.stopWatchingConfig?.();
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
      localHostname: () => os.hostname(),
    });
  }

  async status() {
    const watches = await this.watches.list().catch(() => []);
    return {
      version: MESH_VERSION,
      hosts: this.registry.summaries(),
      localAccess: this.config.localAccess,
      injection: this.config.injection,
      mcp: { url: this.mcp?.url ?? null, error: this.mcpError },
      dataDirectory: this.dataDirectory,
      configError: this.configError,
      watches: watches.length,
    };
  }

  async addPeer(input: {
    name: string;
    connection: string;
    password?: string;
    access: "read" | "write";
    allowedPaths: string[];
  }): Promise<PeerSummary> {
    parseConnectionTarget(input.connection);
    const id = newPeerId();
    await this.mutateConfig((config) => {
      if (config.peers.some((peer) => peer.name === input.name)) {
        throw new Error(`A peer named "${input.name}" already exists`);
      }
      const peer: PeerConfig = {
        id,
        name: input.name,
        connection: input.connection.trim(),
        ...(input.password ? { password: input.password } : {}),
        access: input.access,
        allowedPaths: input.allowedPaths,
        enabled: true,
      };
      return { ...config, peers: [...config.peers, peer] };
    });
    return this.requirePeerSummary(id);
  }

  async updatePeer(input: {
    id: string;
    name?: string;
    connection?: string;
    password?: string | null;
    access?: "read" | "write";
    allowedPaths?: string[];
    enabled?: boolean;
  }): Promise<PeerSummary> {
    if (input.connection !== undefined) parseConnectionTarget(input.connection);
    await this.mutateConfig((config) => {
      const current = config.peers.find((peer) => peer.id === input.id);
      if (!current) throw new Error(`Unknown peer ${input.id}`);
      if (
        input.name !== undefined &&
        config.peers.some((peer) => peer.id !== input.id && peer.name === input.name)
      ) {
        throw new Error(`A peer named "${input.name}" already exists`);
      }
      const next: PeerConfig = {
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.connection !== undefined ? { connection: input.connection.trim() } : {}),
        ...(input.access !== undefined ? { access: input.access } : {}),
        ...(input.allowedPaths !== undefined ? { allowedPaths: input.allowedPaths } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      };
      if (input.password === null) delete next.password;
      else if (input.password !== undefined) next.password = input.password;
      return { ...config, peers: config.peers.map((peer) => (peer.id === input.id ? next : peer)) };
    });
    return this.requirePeerSummary(input.id);
  }

  async removePeer(id: string): Promise<boolean> {
    let removed = false;
    await this.mutateConfig((config) => {
      removed = config.peers.some((peer) => peer.id === id);
      return { ...config, peers: config.peers.filter((peer) => peer.id !== id) };
    });
    return removed;
  }

  provideLocalApi(api: PaseoApi): void {
    this.local.provide(api);
  }

  private requirePeerSummary(id: string): PeerSummary {
    const peer = this.registry.peerById(id);
    if (!peer) throw new Error(`Unknown peer ${id}`);
    return peer.summary();
  }

  private async mutateConfig(mutate: (config: MeshConfig) => MeshConfig): Promise<MeshConfig> {
    const next = await this.configStore.update(mutate);
    this.applyConfig(next);
    return next;
  }

  private async reloadConfig(): Promise<void> {
    try {
      let config = await this.configStore.read();
      if (await this.configStore.rawMatches((raw) => peersMissingIds(raw))) {
        // Persist IDs for hand-written peers so they stay stable across reloads.
        config = await this.configStore.update((current) => current);
      }
      this.applyConfig(config);
      this.configError = null;
    } catch (error) {
      // Keep running with the last good config; surface the problem in status.
      this.configError = messageOf(error);
      this.logger.error(`Config not applied: ${this.configError}`);
    }
  }

  private applyConfig(config: MeshConfig): void {
    this.config = config;
    this.configError = null;
    this.registry.apply(config);
    this.watches.poke();
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
Paths, providers and models always refer to the host you name. Files are not shared between hosts: hand work over through git or messages.
When you create or prompt an agent with notifyOnFinish (default), you receive a message when it finishes, errors or needs permission. Do not poll.`;

function peersMissingIds(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const peers = (raw as { peers?: unknown }).peers;
  return (
    Array.isArray(peers) &&
    peers.some((peer) => typeof peer === "object" && peer !== null && !("id" in peer))
  );
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
