import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  accessLevelSchema,
  appSyncConfigSchema,
  injectionConfigSchema,
  injectionPatchSchema,
  peerNameSchema,
  peerSummarySchema,
} from "./config";
import { skippedHostSchema, syncedHostSchema } from "./sync";

const peerIdSchema = z.object({ id: z.string().min(1) });

export const meshStatusRpc = defineRpc({
  name: "mesh.status",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    hosts: z.array(peerSummarySchema),
    localAccess: accessLevelSchema,
    injection: injectionConfigSchema,
    appSync: appSyncConfigSchema.extend({
      excluded: z.array(z.string()),
      last: z
        .object({
          at: z.string(),
          error: z.string().nullable(),
          added: z.array(z.string()),
          updated: z.array(z.string()),
          removed: z.array(z.string()),
          skipped: z.array(skippedHostSchema),
        })
        .nullable(),
    }),
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
    appSync: z
      .object({
        enabled: z.boolean().optional(),
        access: accessLevelSchema.optional(),
        clearExcluded: z.boolean().optional(),
      })
      .optional(),
  }),
  output: z.object({ localAccess: accessLevelSchema, injection: injectionConfigSchema }),
});

/** This daemon's identity and pairing offer, for other hosts' syncs. */
export const describeSelfRpc = defineRpc({
  name: "mesh.self.describe",
  input: z.object({}),
  output: z.object({
    serverId: z.string().nullable(),
    hostname: z.string().nullable(),
    offerUrl: z.string().nullable(),
    appSyncEnabled: z.boolean(),
  }),
});

/** Reconciles the peers this app manages with the app's host list. */
export const syncPeersRpc = defineRpc({
  name: "mesh.peers.sync",
  input: z.object({
    appId: z.string().regex(/^[a-z0-9-]{8,64}$/),
    hosts: z.array(syncedHostSchema).max(500),
    skipped: z.array(skippedHostSchema).max(500).default([]),
    error: z.string().optional(),
  }),
  output: z.object({
    applied: z.boolean(),
    added: z.array(z.string()),
    updated: z.array(z.string()),
    removed: z.array(z.string()),
  }),
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
