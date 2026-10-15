import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";

export function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 12 : 24, alignItems: "center" as const },
      column: { width: "100%" as const, maxWidth: 760, gap: 12 },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      cardHeader: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 10,
        padding: 12,
      },
      titleLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      hostName: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      badge: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
      },
      count: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
      title: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      rowBody: { flex: 1, gap: 2 },
      dot: { width: 9, height: 9, borderRadius: 5, marginTop: 6 },
      smallDot: { width: 7, height: 7, borderRadius: 4, marginTop: 6 },
      agentRow: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 10,
        paddingVertical: 8,
        paddingLeft: 31,
        paddingRight: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      agentEmpty: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        paddingVertical: 8,
        paddingLeft: 31,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
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
