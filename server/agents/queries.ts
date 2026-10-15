import type { PaseoAgent } from "@getpaseo/client";
import { messageOf } from "../errors";
import { type HostRef, type HostRegistry, hostLabel, hostServerId } from "../hosts/host-registry";
import { isWithin } from "./paths";

export const MESH_LABEL_CALLER_SERVER = "paseo-mesh.caller-server-id";
export const MESH_LABEL_CALLER_AGENT = "paseo-mesh.caller-agent-id";
export const MESH_LABEL_CALLER_HOST = "paseo-mesh.caller-hostname";

export type AgentDirectory = Pick<HostRegistry, "resolve" | "localHost" | "remotePeers" | "api">;

export interface ListAgentsOptions {
  host?: string;
  includeArchived: boolean;
  statuses?: PaseoAgent["status"][];
  cwd?: string;
  limit: number;
}

/** Shared agent query for MCP and app RPC callers. */
export async function listAgents(directory: AgentDirectory, options: ListAgentsOptions) {
  const hosts: HostRef[] = options.host
    ? [directory.resolve(options.host)]
    : [
        directory.localHost(),
        ...directory
          .remotePeers()
          .filter((peer) => peer.peerConfig.enabled)
          .map((peer) => ({ kind: "remote", peer }) as const),
      ];
  const unreachable: Array<{ host: string; error: string }> = [];
  const agents: ReturnType<typeof summarizeAgent>[] = [];
  await Promise.all(
    hosts.map(async (host) => {
      try {
        const api = await directory.api(host, options.host ? 10_000 : 3_000);
        const result = await api.agents.list({
          filter: {
            includeArchived: options.includeArchived,
            ...(options.statuses ? { statuses: options.statuses } : {}),
          },
          sort: [{ key: "updated_at", direction: "desc" }],
          page: { limit: options.limit },
        });
        for (const entry of result.entries) {
          if (options.cwd && !isWithin(entry.agent.cwd, options.cwd)) continue;
          agents.push(summarizeAgent(host, entry.agent));
        }
      } catch (error) {
        if (options.host) throw error;
        unreachable.push({ host: hostLabel(host), error: messageOf(error) });
      }
    }),
  );
  agents.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { agents, unreachable };
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
