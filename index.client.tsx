import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { MeshScreen } from "./client/mesh-screen";
import { PeersSettings } from "./client/peers-settings";

function MeshSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Network"
      label="Mesh"
      active={currentScreen?.screenId === "mesh"}
      onPress={() => openScreen({ screenId: "mesh" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "mesh", title: "Mesh", Component: MeshScreen });
  client.addSidebarHeaderItem({ id: "mesh", title: "Mesh", Component: MeshSidebarItem });
  client.addSettingsScreen({
    id: "peers",
    title: "Peers",
    icon: "Network",
    Component: PeersSettings,
  });
  client.addCommandCenterItem({
    id: "open-mesh",
    title: "Open Mesh hosts and agents",
    icon: "Network",
    keywords: ["mesh", "hosts", "peers", "remote"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "mesh" });
    },
  });
  client.addCommandCenterItem({
    id: "mesh-peers",
    title: "Manage Mesh peers",
    icon: "Settings",
    keywords: ["mesh", "peers", "pair", "relay"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("peers");
    },
  });
  return () => {};
}
