import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PeerSummary } from "../shared/config";
import { listMeshAgentsRpc, type MeshAgent, meshStatusRpc } from "../shared/rpc";
import { statusColor, useStyles } from "./styles";

type Styles = ReturnType<typeof useStyles>;
type Theme = PluginScreenProps["theme"];

export function MeshScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const getStatus = useRpc(meshStatusRpc);
  const listAgents = useRpc(listMeshAgentsRpc);
  const appHosts = useHosts();
  const status = useQuery({
    queryKey: ["mesh", "status"],
    queryFn: () => getStatus({}),
    refetchInterval: 3_000,
  });
  const agents = useQuery({
    queryKey: ["mesh", "agents"],
    queryFn: () => listAgents({ includeArchived: false }),
    refetchInterval: 5_000,
  });
  // Agents can only be opened when this app is also connected to their daemon.
  const openable = useMemo(
    () => new Set(appHosts.filter((host) => host.status === "online").map((host) => host.serverId)),
    [appHosts],
  );
  const agentsByHost = useMemo(() => {
    const grouped = new Map<string, MeshAgent[]>();
    for (const agent of agents.data?.agents ?? []) {
      grouped.set(agent.host, [...(grouped.get(agent.host) ?? []), agent]);
    }
    return grouped;
  }, [agents.data]);

  const openAgent = (agent: MeshAgent) => {
    if (!navigation) return null;
    if (agent.host === "local") return () => navigation.openAgent({ agentId: agent.agentId });
    if (!agent.serverId || !openable.has(agent.serverId)) return null;
    const serverId = agent.serverId;
    return () => navigation.openAgent({ agentId: agent.agentId, serverId });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.column}>
        {status.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
        {status.error ? <Text style={styles.danger}>{status.error.message}</Text> : null}
        {status.data?.configError ? (
          <Text style={styles.danger}>Config not applied: {status.data.configError}</Text>
        ) : null}
        {status.data?.mcp.error ? (
          <Text style={styles.danger}>MCP server failed: {status.data.mcp.error}</Text>
        ) : null}
        {status.data?.hosts.map((host) => (
          <HostCard
            key={host.id}
            host={host}
            agents={agentsByHost.get(host.name) ?? []}
            loadingAgents={agents.isPending}
            styles={styles}
            theme={theme}
            openAgent={openAgent}
          />
        ))}
        {status.data && status.data.hosts.length === 1 ? (
          <Text style={styles.muted}>
            No peers yet. Add one under Settings → Plugins → mesh → Peers.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

function HostCard({
  host,
  agents,
  loadingAgents,
  styles,
  theme,
  openAgent,
}: {
  host: PeerSummary;
  agents: MeshAgent[];
  loadingAgents: boolean;
  styles: Styles;
  theme: Theme;
  openAgent(agent: MeshAgent): (() => void) | null;
}) {
  const details = [
    host.local ? "this daemon" : host.endpoint,
    host.hostname,
    host.version ? `v${host.version}` : null,
  ].filter(Boolean);
  const reachable = host.status === "online";
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.dot, { backgroundColor: statusColor(theme, host.status) }]} />
        <View style={styles.rowBody}>
          <View style={styles.titleLine}>
            <Text style={styles.hostName}>{host.name}</Text>
            <Text style={styles.badge}>{host.status}</Text>
            <Text style={styles.badge}>
              {host.access === "write" ? "read & write" : "read only"}
            </Text>
          </View>
          <Text style={styles.muted} numberOfLines={1}>
            {details.join(" · ")}
          </Text>
          {host.error ? (
            <Text style={styles.danger} numberOfLines={2}>
              {host.error}
            </Text>
          ) : null}
        </View>
        {reachable ? (
          <Text style={styles.count}>
            {agents.length} {agents.length === 1 ? "agent" : "agents"}
          </Text>
        ) : null}
      </View>
      {reachable && loadingAgents ? <Text style={styles.agentEmpty}>Loading agents…</Text> : null}
      {reachable && !loadingAgents && agents.length === 0 ? (
        <Text style={styles.agentEmpty}>No active agents</Text>
      ) : null}
      {agents.map((agent) => (
        <AgentRow
          key={agent.agentId}
          agent={agent}
          styles={styles}
          theme={theme}
          onOpen={openAgent(agent)}
        />
      ))}
    </View>
  );
}

function AgentRow({
  agent,
  styles,
  theme,
  onOpen,
}: {
  agent: MeshAgent;
  styles: Styles;
  theme: Theme;
  onOpen: (() => void) | null;
}) {
  const state = agentState(agent);
  const body = (
    <View style={styles.agentRow}>
      <View
        style={[
          styles.smallDot,
          {
            backgroundColor: statusColor(theme, state.tone),
          },
        ]}
      />
      <View style={styles.rowBody}>
        <Text style={styles.title} numberOfLines={1}>
          {agent.title ?? agent.agentId}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {state.label} · {agent.provider} · {agent.cwd}
        </Text>
      </View>
    </View>
  );
  if (!onOpen) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${agent.title ?? agent.agentId}`}
      onPress={onOpen}
    >
      {body}
    </Pressable>
  );
}

/** One label per agent: the live state wins over a reason left from the previous turn. */
function agentState(agent: MeshAgent): { label: string; tone: string } {
  if (agent.status === "running" || agent.status === "initializing") {
    return { label: agent.status, tone: "running" };
  }
  if (agent.status === "error") return { label: "error", tone: "error" };
  if (agent.requiresAttention && agent.attentionReason) {
    const label =
      agent.attentionReason === "permission" ? "needs permission" : agent.attentionReason;
    return { label, tone: agent.attentionReason === "error" ? "error" : "attention" };
  }
  return { label: agent.status, tone: agent.status };
}
