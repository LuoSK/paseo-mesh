import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { LOCAL_HOST_NAME } from "../shared/config";
import {
  type HostRef,
  type HostRegistry,
  hostAccess,
  hostAllowedPaths,
  hostLabel,
  hostServerId,
} from "./host-registry";
import type { McpCaller, McpTool, McpToolResult } from "./mcp-http";
import type { WatchManager } from "./watches";

export const MESH_LABEL_CALLER_SERVER = "paseo-mesh.caller-server-id";
export const MESH_LABEL_CALLER_AGENT = "paseo-mesh.caller-agent-id";
export const MESH_LABEL_CALLER_HOST = "paseo-mesh.caller-hostname";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 2_000;

export interface ToolContext {
  registry: HostRegistry;
  watches: WatchManager;
  /** Resolves the calling agent from the MCP URL's caller nonce. */
  resolveCaller(caller: McpCaller): string | null;
  localServerId(): string | null;
  localHostname(): string | null;
}

const hostParam = z
  .string()
  .min(1)
  .describe(
    `Host name from mesh_list_hosts, its peer id, or its daemon serverId. "${LOCAL_HOST_NAME}" is the daemon this agent runs on.`,
  );
const agentIdParam = z
  .string()
  .min(1)
  .describe("Full agent ID on that host, as returned by mesh_list_agents or mesh_create_agent.");

const statusSchema = z.enum(["initializing", "idle", "running", "error", "closed"]);

const schemas = {
  listHosts: z.object({}),
  listWorkspaces: z.object({
    host: hostParam,
    query: z.string().optional().describe("Optional text filter on workspace and project names."),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  listAgents: z.object({
    host: hostParam
      .optional()
      .describe("Host to list. Omit to list every reachable host, including this one."),
    includeArchived: z.boolean().default(false),
    statuses: z.array(statusSchema).optional().describe("Only agents in these lifecycle states."),
    cwd: z
      .string()
      .optional()
      .describe("Only agents whose working directory is this path or below it."),
    limit: z.number().int().min(1).max(200).default(50).describe("Maximum agents per host."),
  }),
  getAgent: z.object({ host: hostParam, agentId: agentIdParam }),
  readTimeline: z.object({
    host: hostParam,
    agentId: agentIdParam,
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(30)
      .describe("Most recent timeline items to return."),
    includeReasoning: z.boolean().default(false),
    maxCharsPerItem: z.number().int().min(100).max(20_000).default(MAX_TEXT_CHARS),
  }),
  listProviders: z.object({ host: hostParam }),
  createAgent: z.object({
    host: hostParam,
    cwd: z
      .string()
      .min(1)
      .describe(
        "Absolute working directory ON THAT HOST (not this machine). Use mesh_list_workspaces to find existing paths.",
      ),
    provider: z
      .string()
      .min(1)
      .describe(
        'Provider and model on that host, e.g. "claude/claude-opus-5-5" or "codex/gpt-5.5". Use mesh_list_providers to see what the host has.',
      ),
    prompt: z.string().min(1).describe("First task to run immediately."),
    title: z.string().trim().min(1).max(60).optional().describe("Short title (<= 60 chars)."),
    modeId: z.string().optional().describe("Provider mode on that host, from mesh_list_providers."),
    thinkingOptionId: z.string().optional(),
    notifyOnFinish: z
      .boolean()
      .default(true)
      .describe(
        "Get a message when the agent finishes, errors or needs permission. Set false only for fire-and-forget work.",
      ),
  }),
  sendPrompt: z.object({
    host: hostParam,
    agentId: agentIdParam,
    prompt: z.string().min(1),
    activeTurnBehavior: z
      .enum(["steer", "interrupt"])
      .default("steer")
      .describe(
        "If the agent is mid-turn: steer adds the message to the running turn, interrupt cancels it and starts a new one.",
      ),
    notifyOnFinish: z.boolean().default(true),
  }),
  waitAgent: z.object({
    host: hostParam,
    agentId: agentIdParam,
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .default(50)
      .describe("Give up after this long. Keep under your MCP client's tool timeout."),
  }),
  stopAgent: z.object({ host: hostParam, agentId: agentIdParam }),
  archiveAgent: z.object({ host: hostParam, agentId: agentIdParam }),
};

export const READ_ONLY_TOOL_NAMES = [
  "mesh_list_hosts",
  "mesh_list_workspaces",
  "mesh_list_agents",
  "mesh_get_agent",
  "mesh_read_timeline",
  "mesh_list_providers",
  "mesh_wait_agent",
] as const;

export function createMeshTools(context: ToolContext): McpTool[] {
  const { registry } = context;

  async function hostApi(ref: string): Promise<{ host: HostRef; api: PaseoApi }> {
    const host = registry.resolve(ref);
    return { host, api: await registry.api(host, CONNECT_TIMEOUT_MS) };
  }

  async function requireAgent(api: PaseoApi, host: HostRef, agentId: string): Promise<PaseoAgent> {
    const result = await api.agents.ref(agentId).refresh();
    if (!result) throw new Error(`Agent ${agentId} was not found on host ${hostLabel(host)}`);
    return result.agent;
  }

  return [
    tool({
      name: "mesh_list_hosts",
      title: "List mesh hosts",
      description:
        "List the Paseo hosts this agent can reach: this daemon (local) and every configured peer, with connection status, daemon identity and access level (read or write).",
      schema: schemas.listHosts,
      readOnly: true,
      async run() {
        return {
          hosts: registry.summaries().map((summary) => ({
            name: summary.name,
            id: summary.id,
            status: summary.status,
            access: summary.access,
            serverId: summary.serverId,
            hostname: summary.hostname,
            version: summary.version,
            connection: summary.endpoint,
            error: summary.error,
            allowedPaths: summary.allowedPaths,
          })),
        };
      },
    }),

    tool({
      name: "mesh_list_workspaces",
      title: "List workspaces on a host",
      description:
        "List workspaces (project directories and worktrees) on a host. Paths are paths on that host.",
      schema: schemas.listWorkspaces,
      readOnly: true,
      async run(input) {
        const { host, api } = await hostApi(input.host);
        const result = await api.workspaces.list({
          ...(input.query ? { filter: { query: input.query } } : {}),
          page: { limit: input.limit },
        });
        return {
          host: hostLabel(host),
          serverId: hostServerId(host),
          workspaces: result.entries.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            title: workspace.title ?? null,
            directory: workspace.workspaceDirectory,
            project: workspace.projectDisplayName,
            projectRoot: workspace.projectRootPath,
            kind: workspace.workspaceKind,
            status: workspace.status,
            branch: workspace.project?.checkout?.currentBranch ?? null,
          })),
          hasMore: result.pageInfo.hasMore,
        };
      },
    }),

    tool({
      name: "mesh_list_agents",
      title: "List agents across hosts",
      description:
        "List agents on one host, or on every reachable host when host is omitted. Unreachable hosts are reported in `unreachable` instead of failing the call.",
      schema: schemas.listAgents,
      readOnly: true,
      async run(input) {
        const hosts: HostRef[] = input.host
          ? [registry.resolve(input.host)]
          : [
              registry.localHost(),
              ...registry
                .remotePeers()
                .filter((peer) => peer.peerConfig.enabled)
                .map((peer) => ({ kind: "remote", peer }) as const),
            ];
        const unreachable: Array<{ host: string; error: string }> = [];
        const agents: ReturnType<typeof summarizeAgent>[] = [];
        await Promise.all(
          hosts.map(async (host) => {
            try {
              const api = await registry.api(host, input.host ? CONNECT_TIMEOUT_MS : 3_000);
              const result = await api.agents.list({
                filter: {
                  includeArchived: input.includeArchived,
                  ...(input.statuses ? { statuses: input.statuses } : {}),
                },
                sort: [{ key: "updated_at", direction: "desc" }],
                page: { limit: input.limit },
              });
              for (const entry of result.entries) {
                if (input.cwd && !isWithin(entry.agent.cwd, input.cwd)) continue;
                agents.push(summarizeAgent(host, entry.agent));
              }
            } catch (error) {
              if (input.host) throw error;
              unreachable.push({ host: hostLabel(host), error: messageOf(error) });
            }
          }),
        );
        agents.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        return { agents, unreachable };
      },
    }),

    tool({
      name: "mesh_get_agent",
      title: "Get an agent's status",
      description:
        "Return one agent's status, configuration, pending permissions and last assistant message.",
      schema: schemas.getAgent,
      readOnly: true,
      async run(input) {
        const { host, api } = await hostApi(input.host);
        const agent = await requireAgent(api, host, input.agentId);
        const timeline = await api.agents
          .ref(agent.id)
          .timeline.refetch({ direction: "tail", limit: 50, projection: "projected" });
        const lastAssistant = [...timeline.entries]
          .reverse()
          .find((entry) => entry.item.type === "assistant_message");
        return {
          ...summarizeAgent(host, agent),
          activeTurn: agent.activeTurn ?? null,
          lastError: agent.lastError ?? null,
          pendingPermissions: agent.pendingPermissions,
          currentModeId: agent.currentModeId,
          availableModes: agent.availableModes.map((mode) => mode.id),
          lastAssistantMessage:
            lastAssistant && lastAssistant.item.type === "assistant_message"
              ? truncate(lastAssistant.item.text, MAX_TEXT_CHARS * 2)
              : null,
        };
      },
    }),

    tool({
      name: "mesh_read_timeline",
      title: "Read an agent's timeline",
      description:
        "Read the most recent timeline items of an agent on any host: user and assistant messages, tool calls, errors. Long text is truncated.",
      schema: schemas.readTimeline,
      readOnly: true,
      async run(input) {
        const { host, api } = await hostApi(input.host);
        const timeline = await api.agents.ref(input.agentId).timeline.refetch({
          direction: "tail",
          limit: input.limit,
          projection: "projected",
        });
        if (timeline.error) throw new Error(timeline.error);
        return {
          host: hostLabel(host),
          serverId: hostServerId(host),
          agentId: input.agentId,
          status: timeline.agent?.status ?? null,
          hasOlder: timeline.hasOlder,
          items: timeline.entries
            .map((entry) =>
              condenseItem(entry.item, {
                includeReasoning: input.includeReasoning,
                maxChars: input.maxCharsPerItem,
                timestamp: entry.timestamp,
              }),
            )
            .filter((item) => item !== null),
        };
      },
    }),

    tool({
      name: "mesh_list_providers",
      title: "List providers on a host",
      description:
        "List agent providers, models and modes available on a host. Use the provider/model ids with mesh_create_agent.",
      schema: schemas.listProviders,
      readOnly: true,
      async run(input) {
        const { host, api } = await hostApi(input.host);
        const snapshot = await api.providers.waitForReady({ timeoutMs: 20_000 });
        return {
          host: hostLabel(host),
          providers: snapshot.entries
            .filter((entry) => entry.enabled !== false)
            .map((entry) => ({
              provider: entry.provider,
              label: entry.label,
              status: entry.status,
              defaultModeId: entry.defaultModeId ?? null,
              modes: (entry.modes ?? []).map((mode) => mode.id),
              models: (entry.models ?? []).map((model) => ({
                id: `${entry.provider}/${model.id}`,
                label: model.label,
                isDefault: model.isDefault ?? false,
                thinkingOptions: (model.thinkingOptions ?? []).map((option) => option.id),
              })),
            })),
        };
      },
    }),

    tool({
      name: "mesh_create_agent",
      title: "Create an agent on a host",
      description:
        "Create an agent on any mesh host and start it on a task. The cwd and provider refer to that host. By default you get a message when it finishes, errors or needs permission; do not poll, continue other work until then.",
      schema: schemas.createAgent,
      readOnly: false,
      async run(input, caller) {
        const host = registry.resolve(input.host);
        requireWrite(host);
        requireAllowedPath(host, input.cwd);
        const api = await registry.api(host, CONNECT_TIMEOUT_MS);
        const callerAgentId = context.resolveCaller(caller);
        const provider = input.provider.includes("/")
          ? input.provider
          : await defaultModel(api, input.provider);
        const labels: Record<string, string> = {};
        const localServerId = context.localServerId();
        if (localServerId) labels[MESH_LABEL_CALLER_SERVER] = localServerId;
        if (callerAgentId) labels[MESH_LABEL_CALLER_AGENT] = callerAgentId;
        const hostname = context.localHostname();
        if (hostname) labels[MESH_LABEL_CALLER_HOST] = hostname;
        const workspace = await api.workspaces.open(input.cwd);
        const created = await workspace.agents.create({
          config: {
            provider,
            ...(input.modeId ? { modeId: input.modeId } : {}),
            ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
          },
          ...(input.title ? { title: input.title } : {}),
          prompt: input.prompt,
          labels,
        });
        const notify = await armNotification(
          context,
          host,
          created.id,
          callerAgentId,
          input.notifyOnFinish,
        );
        const snapshot = created.current();
        return {
          host: hostLabel(host),
          serverId: hostServerId(host),
          agentId: created.id,
          workspaceId: workspace.id,
          cwd: snapshot?.cwd ?? input.cwd,
          status: snapshot?.status ?? null,
          provider,
          notifyOnFinish: notify.armed,
          guidance: notify.guidance,
        };
      },
    }),

    tool({
      name: "mesh_send_prompt",
      title: "Send a prompt to an agent on a host",
      description:
        "Send a follow-up task or message to an existing agent on any host. Returns once the host accepts it. By default you get a message when the agent finishes, errors or needs permission.",
      schema: schemas.sendPrompt,
      readOnly: false,
      async run(input, caller) {
        const host = registry.resolve(input.host);
        requireWrite(host);
        const api = await registry.api(host, CONNECT_TIMEOUT_MS);
        const agent = await requireAgent(api, host, input.agentId);
        await api.agents.ref(agent.id).send(input.prompt, {
          activeTurnBehavior: input.activeTurnBehavior,
        });
        const callerAgentId = context.resolveCaller(caller);
        const notify = await armNotification(
          context,
          host,
          agent.id,
          callerAgentId,
          input.notifyOnFinish,
        );
        return {
          host: hostLabel(host),
          serverId: hostServerId(host),
          agentId: agent.id,
          accepted: true,
          notifyOnFinish: notify.armed,
          guidance: notify.guidance,
        };
      },
    }),

    tool({
      name: "mesh_wait_agent",
      title: "Wait for an agent on a host",
      description:
        "Block until an agent's current turn finishes, errors or needs permission, or until timeoutSeconds passes. Prefer finish notifications; use this when you need the result before continuing.",
      schema: schemas.waitAgent,
      readOnly: true,
      async run(input) {
        const host = registry.resolve(input.host);
        const ops = await registry.ops(host, CONNECT_TIMEOUT_MS);
        const result = await ops.waitForFinish(input.agentId, input.timeoutSeconds * 1000);
        return {
          host: hostLabel(host),
          serverId: hostServerId(host),
          agentId: input.agentId,
          status: result.status,
          error: result.error,
          agentStatus: result.final?.status ?? null,
          pendingPermissions: result.final?.pendingPermissions ?? [],
          lastMessage: result.lastMessage ? truncate(result.lastMessage, MAX_TEXT_CHARS * 2) : null,
        };
      },
    }),

    tool({
      name: "mesh_stop_agent",
      title: "Stop an agent's running turn",
      description:
        "Cancel the running turn of an agent on a remote host. The agent stays available for new prompts.",
      schema: schemas.stopAgent,
      readOnly: false,
      destructive: true,
      async run(input) {
        const host = registry.resolve(input.host);
        requireWrite(host);
        const ops = await registry.ops(host, CONNECT_TIMEOUT_MS);
        const agent = await requireAgent(ops.api, host, input.agentId);
        if (agent.status !== "running") {
          return { host: hostLabel(host), agentId: agent.id, stopped: false, status: agent.status };
        }
        await ops.cancel(agent.id);
        return { host: hostLabel(host), agentId: agent.id, stopped: true };
      },
    }),

    tool({
      name: "mesh_archive_agent",
      title: "Archive an agent on a host",
      description:
        "Archive an agent on any host. It disappears from active lists; its history is kept and a new prompt restores it.",
      schema: schemas.archiveAgent,
      readOnly: false,
      destructive: true,
      async run(input) {
        const { host, api } = await hostApi(input.host);
        requireWrite(host);
        const agent = await requireAgent(api, host, input.agentId);
        const { archivedAt } = await api.agents.ref(agent.id).archive();
        return { host: hostLabel(host), agentId: agent.id, archivedAt };
      },
    }),
  ];
}

async function armNotification(
  context: ToolContext,
  host: HostRef,
  agentId: string,
  callerAgentId: string | null,
  requested: boolean,
): Promise<{ armed: boolean; guidance: string }> {
  if (!requested) {
    return {
      armed: false,
      guidance: "No notification requested. Use mesh_wait_agent or mesh_get_agent to observe it.",
    };
  }
  if (!callerAgentId) {
    return {
      armed: false,
      guidance:
        "Notifications are unavailable because this session's caller is unknown (agents created before paseo-mesh was installed). Use mesh_wait_agent instead.",
    };
  }
  await context.watches.add({ host, agentId, notifyAgentId: callerAgentId });
  return {
    armed: true,
    guidance:
      "You will get a message when the agent finishes, errors or needs permission. Do not poll; continue with other work until it arrives.",
  };
}

async function defaultModel(api: PaseoApi, provider: string): Promise<string> {
  const snapshot = await api.providers.waitForReady({ timeoutMs: 20_000 });
  const entry = snapshot.entries.find((candidate) => candidate.provider === provider);
  if (!entry) {
    const known = snapshot.entries.map((candidate) => candidate.provider).join(", ");
    throw new Error(`Provider "${provider}" is not available on that host. Available: ${known}`);
  }
  const model = entry.models?.find((candidate) => candidate.isDefault) ?? entry.models?.[0];
  if (!model) throw new Error(`Provider "${provider}" reports no models on that host`);
  return `${provider}/${model.id}`;
}

function requireWrite(host: HostRef): void {
  if (hostAccess(host) !== "write") {
    throw new Error(
      `Host ${hostLabel(host)} is read-only in mesh. Grant write access in the paseo-mesh settings to create or control agents there.`,
    );
  }
}

function requireAllowedPath(host: HostRef, cwd: string): void {
  if (!isAbsolutePath(cwd)) {
    throw new Error(`cwd must be an absolute path on host ${hostLabel(host)}: ${cwd}`);
  }
  const allowed = hostAllowedPaths(host);
  if (allowed.length === 0) return;
  if (!allowed.some((prefix) => isWithin(cwd, prefix))) {
    throw new Error(
      `cwd ${cwd} is outside the paths allowed on host ${hostLabel(host)}: ${allowed.join(", ")}`,
    );
  }
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** True when `child` is `parent` or below it. Works for POSIX and Windows paths on any host. */
export function isWithin(child: string, parent: string): boolean {
  const normalize = (value: string) => {
    const windows = /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\");
    let out = value.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
    return windows ? out.toLowerCase() : out;
  };
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(prefix);
}

export function summarizeAgent(host: HostRef, agent: PaseoAgent) {
  return {
    host: hostLabel(host),
    serverId: hostServerId(host),
    agentId: agent.id,
    title: agent.title,
    status: agent.status,
    provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    archivedAt: agent.archivedAt ?? null,
    parentAgentId: agent.labels["paseo.parent-agent-id"] ?? null,
    meshCaller: agent.labels[MESH_LABEL_CALLER_AGENT]
      ? {
          serverId: agent.labels[MESH_LABEL_CALLER_SERVER] ?? null,
          agentId: agent.labels[MESH_LABEL_CALLER_AGENT],
          hostname: agent.labels[MESH_LABEL_CALLER_HOST] ?? null,
        }
      : null,
  };
}

type TimelineItem = Awaited<
  ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"] extends (
    ...args: never[]
  ) => Promise<infer R>
    ? R
    : never
>["entries"][number]["item"];

export function condenseItem(
  item: TimelineItem,
  options: { includeReasoning: boolean; maxChars: number; timestamp?: string },
): Record<string, unknown> | null {
  const at = options.timestamp ? { at: options.timestamp } : {};
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return { type: item.type, text: truncate(item.text, options.maxChars), ...at };
    case "reasoning":
      return options.includeReasoning
        ? { type: item.type, text: truncate(item.text, options.maxChars), ...at }
        : null;
    case "tool_call":
      return {
        type: "tool_call",
        name: item.name,
        status: item.status,
        ...(item.error ? { error: truncate(stringify(item.error), options.maxChars) } : {}),
        ...at,
      };
    case "error":
      return { type: "error", message: truncate(item.message, options.maxChars), ...at };
    case "todo":
      return { type: "todo", items: item.items, ...at };
    default:
      return { type: item.type, ...at };
  }
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ToolSpec<Schema extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  readOnly: boolean;
  destructive?: boolean;
  run(input: z.output<Schema>, caller: McpCaller): Promise<unknown>;
}

function tool<Schema extends z.ZodType>(spec: ToolSpec<Schema>): McpTool {
  const inputSchema = z.toJSONSchema(spec.schema, { io: "input", target: "draft-7" }) as Record<
    string,
    unknown
  >;
  delete inputSchema.$schema;
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema,
    annotations: {
      title: spec.title,
      readOnlyHint: spec.readOnly,
      destructiveHint: spec.destructive ?? false,
      openWorldHint: true,
    },
    async call(args, { caller }): Promise<McpToolResult> {
      const parsed = spec.schema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${z.prettifyError(parsed.error)}` }],
          isError: true,
        };
      }
      const result = await spec.run(parsed.data, caller);
      const structured = JSON.parse(JSON.stringify(result ?? {})) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    },
  };
}
