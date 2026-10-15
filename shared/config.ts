import { z } from "zod";

export const PEER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const LOCAL_HOST_NAME = "local";

export const accessLevelSchema = z.enum(["read", "write"]);
export type AccessLevel = z.infer<typeof accessLevelSchema>;

export const peerNameSchema = z
  .string()
  .trim()
  .regex(PEER_NAME_PATTERN, "Use lowercase letters, digits, '.', '_' or '-' (max 63)")
  .refine((name) => name !== LOCAL_HOST_NAME, `"${LOCAL_HOST_NAME}" is reserved for this host`);

/** A peer as stored on disk. `password` never leaves the daemon host. */
export const peerConfigSchema = z.object({
  /** Stable identity. Names are labels and may change; watches and caches key on this ID. */
  id: z.string().regex(/^peer_[a-z0-9]{8,32}$/),
  name: peerNameSchema,
  /** Pairing offer URL, or a direct `host:port` / `ws://` / `wss://` endpoint. */
  connection: z.string().trim().min(1),
  password: z.string().optional(),
  access: accessLevelSchema.default("read"),
  /** Absolute path prefixes on the peer where mesh may create agents. Empty means anywhere. */
  allowedPaths: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
});
export type PeerConfig = z.infer<typeof peerConfigSchema>;

export const injectionConfigSchema = z.object({
  /** Give new agents on this host the mesh MCP server. */
  enabled: z.boolean().default(true),
  /** Providers that cannot take MCP servers. Injecting into them fails agent creation. */
  excludeProviders: z.array(z.string()).default(["pi"]),
  /** Let agents call read-only mesh tools without a permission prompt. */
  preapproveReadOnlyTools: z.boolean().default(true),
  /**
   * Providers that accept exact MCP tool preapproval. Paseo rejects a tool policy for any
   * other provider, so preapproval is only added for these.
   */
  preapproveProviders: z.array(z.string()).default(["claude", "codex", "opencode"]),
});
export type InjectionConfig = z.infer<typeof injectionConfigSchema>;

export const meshConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    peers: z.array(peerConfigSchema).default([]),
    /** Access granted to the orchestrating host itself through the `local` name. */
    localAccess: accessLevelSchema.default("write"),
    injection: injectionConfigSchema.default(injectionConfigSchema.parse({})),
  })
  .superRefine((config, ctx) => {
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const [index, peer] of config.peers.entries()) {
      if (names.has(peer.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["peers", index, "name"],
          message: `Duplicate peer name "${peer.name}"`,
        });
      }
      if (ids.has(peer.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["peers", index, "id"],
          message: `Duplicate peer id "${peer.id}"`,
        });
      }
      names.add(peer.name);
      ids.add(peer.id);
    }
  });
export type MeshConfig = z.infer<typeof meshConfigSchema>;

export const hostStatusSchema = z.enum(["connecting", "online", "offline", "error", "disabled"]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

/** Peer view safe to hand to clients: no password, connection redacted. */
export const peerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  local: z.boolean(),
  kind: z.enum(["local", "relay", "direct"]),
  endpoint: z.string(),
  access: accessLevelSchema,
  allowedPaths: z.array(z.string()),
  enabled: z.boolean(),
  hasPassword: z.boolean(),
  status: hostStatusSchema,
  error: z.string().nullable(),
  serverId: z.string().nullable(),
  hostname: z.string().nullable(),
  version: z.string().nullable(),
});
export type PeerSummary = z.infer<typeof peerSummarySchema>;
