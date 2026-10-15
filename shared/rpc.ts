import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  accessLevelSchema,
  injectionConfigSchema,
  injectionPatchSchema,
  peerNameSchema,
  peerSummarySchema,
} from "./config";

const peerIdSchema = z.object({ id: z.string().min(1) });

export const meshStatusRpc = defineRpc({
  name: "mesh.status",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    hosts: z.array(peerSummarySchema),
    localAccess: accessLevelSchema,
    injection: injectionConfigSchema,
    mcp: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
    dataDirectory: z.string(),
    configError: z.string().nullable(),
    watches: z.number().int(),
  }),
});

export const addPeerRpc = defineRpc({
  name: "mesh.peers.add",
  input: z.object({
    name: peerNameSchema,
    connection: z.string().trim().min(1),
    password: z.string().optional(),
    access: accessLevelSchema.default("read"),
    allowedPaths: z.array(z.string().trim().min(1)).default([]),
  }),
  output: peerSummarySchema,
});

export const updatePeerRpc = defineRpc({
  name: "mesh.peers.update",
  input: z.object({
    id: z.string().min(1),
    name: peerNameSchema.optional(),
    connection: z.string().trim().min(1).optional(),
    /** A string replaces the password, null clears it, omitted keeps it. */
    password: z.string().nullable().optional(),
    access: accessLevelSchema.optional(),
    allowedPaths: z.array(z.string().trim().min(1)).optional(),
    enabled: z.boolean().optional(),
  }),
  output: peerSummarySchema,
});

export const removePeerRpc = defineRpc({
  name: "mesh.peers.remove",
  input: peerIdSchema,
  output: z.object({ removed: z.boolean() }),
});

export const retryPeerRpc = defineRpc({
  name: "mesh.peers.retry",
  input: peerIdSchema,
  output: peerSummarySchema,
});

export const updateSettingsRpc = defineRpc({
  name: "mesh.settings.update",
  input: z.object({
    localAccess: accessLevelSchema.optional(),
    injection: injectionPatchSchema.optional(),
  }),
  output: z.object({ localAccess: accessLevelSchema, injection: injectionConfigSchema }),
});

export const meshAgentSchema = z.object({
  host: z.string(),
  serverId: z.string().nullable(),
  agentId: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  provider: z.string(),
  cwd: z.string(),
  requiresAttention: z.boolean(),
  attentionReason: z.string().nullable(),
  updatedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
export type MeshAgent = z.infer<typeof meshAgentSchema>;

export const listMeshAgentsRpc = defineRpc({
  name: "mesh.agents.list",
  input: z.object({ includeArchived: z.boolean().default(false) }),
  output: z.object({
    agents: z.array(meshAgentSchema),
    unreachable: z.array(z.object({ host: z.string(), error: z.string() })),
  }),
});
