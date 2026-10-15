import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { type PluginHostSummary, useHosts, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { AccessLevel, PeerSummary } from "../shared/config";
import {
  addPeerRpc,
  meshStatusRpc,
  removePeerRpc,
  retryPeerRpc,
  updatePeerRpc,
  updateSettingsRpc,
} from "../shared/rpc";
import { statusColor } from "./styles";

const ACCESS_OPTIONS = [
  { label: "Read only", value: "read" },
  { label: "Read and write", value: "write" },
] as const;

const STATUS_KEY = ["mesh", "status"] as const;

export function PeersSettings({ theme }: PluginSurfaceProps) {
  const getStatus = useRpc(meshStatusRpc);
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => getStatus({}),
    refetchInterval: 3_000,
  });
  const text = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted, fontSize: 12 }), [theme]);
  const danger = useMemo(() => ({ color: theme.colors.statusDanger, fontSize: 12 }), [theme]);
  const appHosts = useHosts();
  const [prefill, setPrefill] = useState<{ name: string; key: number }>({ name: "", key: 0 });
  // Hosts this app is connected to that mesh cannot reach yet, matched by daemon identity.
  const missing = useMemo(() => {
    const known = new Set(
      (status.data?.hosts ?? []).map((host) => host.serverId).filter((id): id is string => !!id),
    );
    return appHosts.filter((host) => !known.has(host.serverId));
  }, [appHosts, status.data]);

  if (status.isPending) return <Text style={text}>Loading…</Text>;
  if (status.error) {
    return (
      <SettingsSection title="Peers">
        <Text style={danger}>{status.error.message}</Text>
        <SettingsAction
          label="Try again"
          actionLabel="Reload"
          onPress={() => void status.refetch()}
        />
      </SettingsSection>
    );
  }
  const peers = status.data.hosts.filter((host) => !host.local);
  return (
    <View style={{ gap: 16 }}>
      {status.data.configError ? (
        <Text style={danger}>Config file not applied: {status.data.configError}</Text>
      ) : null}
      <SettingsSection title="Peers">
        {peers.length === 0 ? (
          <Text style={muted}>No peers yet. Add the hosts this daemon should reach.</Text>
        ) : null}
        {peers.map((peer) => (
          <PeerCard key={peer.id} peer={peer} theme={theme} />
        ))}
      </SettingsSection>
      {missing.length > 0 ? (
        <AppHosts
          hosts={missing}
          theme={theme}
          onUse={(host) =>
            setPrefill((current) => ({ name: peerNameFor(host.label), key: current.key + 1 }))
          }
        />
      ) : null}
      <AddPeer key={prefill.key} initialName={prefill.name} />
      <AgentAccess
        localAccess={status.data.localAccess}
        injection={status.data.injection}
        mcpUrl={status.data.mcp.url}
        dataDirectory={status.data.dataDirectory}
        theme={theme}
      />
    </View>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: ["mesh"] }), [queryClient]);
}

function PeerCard({ peer, theme }: { peer: PeerSummary; theme: PluginSurfaceProps["theme"] }) {
  const toast = useToast();
  const refresh = useRefresh();
  const update = useRpc(updatePeerRpc);
  const remove = useRpc(removePeerRpc);
  const retry = useRpc(retryPeerRpc);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const mutation = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: () => void refresh(),
    onError: (error) => toast.error(error.message),
  });
  const busy = mutation.isPending;
  const statusLine = `${peer.status}${peer.hostname ? ` · ${peer.hostname}` : ""}${peer.version ? ` · v${peer.version}` : ""}`;

  return (
    <SettingsCard>
      <SettingsRow label={peer.name} hint={peer.endpoint}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: statusColor(theme, peer.status),
            }}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{statusLine}</Text>
        </View>
      </SettingsRow>
      {peer.error ? <SettingsRow label="Problem" error={peer.error} /> : null}
      <SettingsSelect<AccessLevel>
        label="Access"
        hint="Write lets agents create and control agents on this host"
        value={peer.access}
        options={ACCESS_OPTIONS}
        disabled={busy}
        onValueChange={(access) => mutation.mutate(() => update({ id: peer.id, access }))}
      />
      <SettingsSwitch
        label="Enabled"
        value={peer.enabled}
        disabled={busy}
        onValueChange={(enabled) => mutation.mutate(() => update({ id: peer.id, enabled }))}
      />
      {peer.status === "offline" || peer.status === "error" ? (
        <SettingsAction
          label="Connection"
          actionLabel="Retry now"
          disabled={busy}
          onPress={() => mutation.mutate(() => retry({ id: peer.id }))}
        />
      ) : null}
      <SettingsAction
        label="Name, connection, password, allowed paths"
        actionLabel={editing ? "Close" : "Edit"}
        disabled={busy}
        onPress={() => setEditing((value) => !value)}
      />
      {editing ? <EditPeer peer={peer} onDone={() => setEditing(false)} /> : null}
      <SettingsAction
        label={
          confirmRemove
            ? `Remove ${peer.name}? Pending notifications wait for it to return.`
            : "Remove peer"
        }
        actionLabel={confirmRemove ? "Confirm remove" : "Remove"}
        disabled={busy}
        onPress={() => {
          if (!confirmRemove) {
            setConfirmRemove(true);
            return;
          }
          mutation.mutate(() => remove({ id: peer.id }));
        }}
      />
    </SettingsCard>
  );
}

function EditPeer({ peer, onDone }: { peer: PeerSummary; onDone(): void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const update = useRpc(updatePeerRpc);
  const [name, setName] = useState(peer.name);
  const [connection, setConnection] = useState("");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [paths, setPaths] = useState(peer.allowedPaths.join(", "));
  const save = useMutation({
    mutationFn: () =>
      update({
        id: peer.id,
        ...(name.trim() !== peer.name ? { name: name.trim() } : {}),
        ...(connection.trim() ? { connection: connection.trim() } : {}),
        ...(clearPassword ? { password: null } : password ? { password } : {}),
        allowedPaths: splitPaths(paths),
      }),
    onSuccess: () => {
      void refresh();
      toast.show("Peer saved", { variant: "success" });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <>
      <SettingsInput label="Name" initialValue={peer.name} onChangeText={setName} />
      <SettingsInput
        label="New connection"
        hint="Leave empty to keep the current one. Pairing offer URL, host:port, ws:// or wss://"
        placeholder="https://app.paseo.sh/#offer=…"
        onChangeText={setConnection}
      />
      <SettingsInput
        label="New password"
        hint={
          peer.hasPassword
            ? "A password is set. Leave empty to keep it."
            : "Only for direct connections with a daemon password"
        }
        secureTextEntry
        onChangeText={setPassword}
      />
      {peer.hasPassword ? (
        <SettingsSwitch
          label="Clear password"
          value={clearPassword}
          onValueChange={setClearPassword}
        />
      ) : null}
      <SettingsInput
        label="Allowed paths"
        hint="Comma-separated absolute paths on that host. Empty allows any path."
        initialValue={peer.allowedPaths.join(", ")}
        onChangeText={setPaths}
      />
      <SettingsAction
        label="Apply changes"
        actionLabel={save.isPending ? "Saving…" : "Save"}
        disabled={save.isPending}
        onPress={() => save.mutate()}
      />
    </>
  );
}

function AppHosts({
  hosts,
  theme,
  onUse,
}: {
  hosts: readonly PluginHostSummary[];
  theme: PluginSurfaceProps["theme"];
  onUse(host: PluginHostSummary): void;
}) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <SettingsSection title="Hosts in this app that mesh cannot reach yet">
      <Text style={muted}>
        Agents can only use hosts added here. For each host: in this app open Settings → that host →
        Pair device, copy the link, then paste it as the connection below.
      </Text>
      <SettingsCard>
        {hosts.map((host) => (
          <SettingsAction
            key={host.serverId}
            label={host.label}
            hint={`${host.status} · ${host.serverId}`}
            actionLabel="Add as peer"
            onPress={() => onUse(host)}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Turns an app host label into a valid peer name, e.g. "Devbox CN" → "devbox-cn". */
export function peerNameFor(label: string): string {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 63);
  return name && name !== "local" ? name : "";
}

function AddPeer({ initialName }: { initialName: string }) {
  const toast = useToast();
  const refresh = useRefresh();
  const add = useRpc(addPeerRpc);
  const [formKey, setFormKey] = useState(0);
  const [name, setName] = useState(initialName);
  const [connection, setConnection] = useState("");
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<AccessLevel>("read");
  const [paths, setPaths] = useState("");
  const save = useMutation({
    mutationFn: () =>
      add({
        name: name.trim(),
        connection: connection.trim(),
        ...(password ? { password } : {}),
        access,
        allowedPaths: splitPaths(paths),
      }),
    onSuccess: (peer) => {
      void refresh();
      toast.show(`Added ${peer.name}`, { variant: "success" });
      setName("");
      setConnection("");
      setPassword("");
      setPaths("");
      setAccess("read");
      setFormKey((key) => key + 1);
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <SettingsSection title="Add a peer">
      <SettingsCard key={formKey}>
        <SettingsInput
          label="Name"
          hint="Lowercase letters, digits, '.', '_' or '-'. Agents address the host by this name."
          placeholder="gpu-box"
          initialValue={initialName}
          onChangeText={setName}
        />
        <SettingsInput
          label="Connection"
          hint="Pairing link from Settings → that host → Pair device in this app, or from `paseo daemon pair` on that host. host:port, ws:// and wss:// work for direct connections."
          placeholder="https://app.paseo.sh/#offer=…"
          onChangeText={setConnection}
        />
        <SettingsInput
          label="Password"
          hint="Only needed when the daemon has a password"
          secureTextEntry
          onChangeText={setPassword}
        />
        <SettingsSelect<AccessLevel>
          label="Access"
          value={access}
          options={ACCESS_OPTIONS}
          onValueChange={setAccess}
        />
        <SettingsInput
          label="Allowed paths"
          hint="Comma-separated absolute paths on that host. Empty allows any path."
          onChangeText={setPaths}
        />
        <SettingsAction
          label="Save this peer"
          actionLabel={save.isPending ? "Adding…" : "Add peer"}
          disabled={save.isPending || !name.trim() || !connection.trim()}
          onPress={() => save.mutate()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function AgentAccess({
  localAccess,
  injection,
  mcpUrl,
  dataDirectory,
  theme,
}: {
  localAccess: AccessLevel;
  injection: {
    enabled: boolean;
    preapproveReadOnlyTools: boolean;
    excludeProviders: string[];
    preapproveProviders: string[];
  };
  mcpUrl: string | null;
  dataDirectory: string;
  theme: PluginSurfaceProps["theme"];
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const updateSettings = useRpc(updateSettingsRpc);
  const mutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => void refresh(),
    onError: (error) => toast.error(error.message),
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <SettingsSection title="Agents on this host">
      <SettingsCard>
        <SettingsSwitch
          label="Give new agents mesh tools"
          hint={`Skipped for: ${injection.excludeProviders.join(", ") || "none"}. Existing agents keep their tools.`}
          value={injection.enabled}
          disabled={mutation.isPending}
          onValueChange={(enabled) => mutation.mutate({ injection: { enabled } })}
        />
        <SettingsSwitch
          label="Allow read-only tools without asking"
          hint={`Applies to ${injection.preapproveProviders.join(", ")}`}
          value={injection.preapproveReadOnlyTools}
          disabled={mutation.isPending}
          onValueChange={(preapproveReadOnlyTools) =>
            mutation.mutate({ injection: { preapproveReadOnlyTools } })
          }
        />
        <SettingsSelect<AccessLevel>
          label="Access to this host"
          hint="What mesh tools may do on the local host"
          value={localAccess}
          options={ACCESS_OPTIONS}
          disabled={mutation.isPending}
          onValueChange={(value) => mutation.mutate({ localAccess: value })}
        />
        <SettingsRow label="MCP endpoint">
          <Text style={muted}>{mcpUrl ?? "not running"}</Text>
        </SettingsRow>
        <SettingsRow label="Data directory">
          <Text style={muted}>{dataDirectory}</Text>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function splitPaths(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
