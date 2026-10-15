import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";

export function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 8 },
      heading: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      sectionGap: { marginTop: 16 },
      title: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      row: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 10,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      rowBody: { flex: 1, gap: 2 },
      dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
      text: { color: theme.colors.foreground },
    }),
    [theme, compact],
  );
}

export function statusColor(theme: PluginTheme, status: string): string {
  switch (status) {
    case "online":
    case "idle":
      return theme.colors.statusSuccess;
    case "running":
    case "connecting":
    case "initializing":
      return theme.colors.accent;
    case "attention":
    case "offline":
      return theme.colors.statusWarning;
    case "error":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}
