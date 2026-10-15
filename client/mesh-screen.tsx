import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PeerSummary } from "../shared/config";
import { listMeshAgentsRpc, type MeshAgent, meshStatusRpc } from "../shared/rpc";
import { statusColor, useStyles } from "./styles";

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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Hosts</Text>
      {status.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
      {status.error ? <Text style={styles.danger}>{String(status.error.message)}</Text> : null}
      {status.data?.configError ? (
        <Text style={styles.danger}>Config not applied: {status.data.configError}</Text>
      ) : null}
      {status.data?.mcp.error ? (
        <Text style={styles.danger}>MCP server failed: {status.data.mcp.error}</Text>
      ) : null}
      {status.data?.hosts.map((host) => (
        <HostRow key={host.id} host={host} styles={styles} theme={theme} />
      ))}
      {status.data && status.data.hosts.length === 1 ? (
        <Text style={styles.muted}>
          No peers yet. Add one under Settings → Plugins → Paseo Mesh → Peers.
        </Text>
      ) : null}

      <Text style={[styles.heading, styles.sectionGap]}>Agents</Text>
      {agents.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
      {agents.error ? <Text style={styles.danger}>{String(agents.error.message)}</Text> : null}
      {agents.data?.unreachable.map((entry) => (
        <Text key={entry.host} style={styles.warning}>
          {entry.host}: {entry.error}
        </Text>
      ))}
      {agents.data?.agents.length === 0 ? <Text style={styles.muted}>No agents.</Text> : null}
      {agents.data?.agents.map((agent) => (
        <AgentRow
          key={`${agent.serverId ?? agent.host}:${agent.agentId}`}
          agent={agent}
          styles={styles}
          theme={theme}
          onOpen={
            navigation &&
            (agent.host === "local" || (agent.serverId && openable.has(agent.serverId)))
              ? () =>
                  navigation.openAgent({
                    agentId: agent.agentId,
                    ...(agent.host === "local" || !agent.serverId
                      ? {}
                      : { serverId: agent.serverId }),
                  })
              : null
          }
        />
      ))}
    </ScrollView>
  );
}

function HostRow({
  host,
  styles,
  theme,
}: {
  host: PeerSummary;
  styles: ReturnType<typeof useStyles>;
  theme: PluginScreenProps["theme"];
}) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: statusColor(theme, host.status) }]} />
      <View style={styles.rowBody}>
        <Text style={styles.title}>
          {host.name}
          <Text style={styles.muted}>
            {"  "}
            {host.status} · {host.access}
          </Text>
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {host.local ? "this daemon" : host.endpoint}
          {host.hostname ? ` · ${host.hostname}` : ""}
          {host.version ? ` · v${host.version}` : ""}
        </Text>
        {host.error ? (
          <Text style={styles.danger} numberOfLines={2}>
            {host.error}
          </Text>
        ) : null}
      </View>
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
  styles: ReturnType<typeof useStyles>;
  theme: PluginScreenProps["theme"];
  onOpen: (() => void) | null;
}) {
  const body = (
    <View style={styles.row}>
      <View
        style={[
          styles.dot,
          {
            backgroundColor: statusColor(
              theme,
              agent.requiresAttention ? "attention" : agent.status,
            ),
          },
        ]}
      />
      <View style={styles.rowBody}>
        <Text style={styles.title} numberOfLines={1}>
          {agent.title ?? agent.agentId}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {agent.host} · {agent.status}
          {agent.attentionReason ? ` (${agent.attentionReason})` : ""} · {agent.provider}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {agent.cwd}
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
