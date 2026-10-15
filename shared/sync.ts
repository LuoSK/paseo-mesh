import { z } from "zod";

// App host sync. The Paseo app keeps its Hosts list as JSON in AsyncStorage under
// `@paseo:daemon-registry` (localStorage on web and desktop). The plugin API exposes only ids,
// labels and status, so the sync reads that storage directly. The schema below accepts the
// fields mesh needs and ignores the rest; any other shape stops the sync instead of guessing.

export const APP_REGISTRY_KEY = "@paseo:daemon-registry";
export const APP_ID_KEY = "@paseo-mesh:app-id";

const appConnectionSchema = z
  .object({
    type: z.string(),
    endpoint: z.string().optional(),
    useTls: z.boolean().optional(),
    password: z.string().optional(),
    host: z.string().optional(),
    sshPort: z.number().int().optional(),
    daemonPort: z.number().int().optional(),
    relayEndpoint: z.string().optional(),
    daemonPublicKeyB64: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough();

const appHostSchema = z
  .object({
    serverId: z.string().trim().min(1),
    label: z.string().optional(),
    password: z.string().optional(),
    connections: z.array(appConnectionSchema).min(1),
  })
  .passthrough();

export type AppHost = z.infer<typeof appHostSchema>;
type AppConnection = z.infer<typeof appConnectionSchema>;

export function parseAppRegistry(raw: string | null): AppHost[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The app's host list is not valid JSON");
  }
  const parsed = z.array(appHostSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "The app's host list has an unexpected format; this Paseo version may not be supported yet",
    );
  }
  return parsed.data;
}

export const syncedHostSchema = z.object({
  serverId: z.string().min(1),
  label: z.string(),
  connection: z.string().min(1),
  password: z.string().optional(),
});
export type SyncedHost = z.infer<typeof syncedHostSchema>;

export const skippedHostSchema = z.object({ label: z.string(), reason: z.string() });
export type SkippedHost = z.infer<typeof skippedHostSchema>;

/** Turns an app host label into a valid peer name, e.g. "Devbox CN" → "devbox-cn". */
export function peerNameFor(label: string): string {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 63);
  return name && name !== "local" ? name : "";
}

function isLoopback(endpoint: string): boolean {
  const host = endpoint
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.") || host === "0.0.0.0";
}

/** True when the app reaches this host on the app's own machine (loopback, socket or pipe). */
export function isOnAppMachine(host: AppHost): boolean {
  return host.connections.some(
    (connection) =>
      connection.type === "directSocket" ||
      connection.type === "directPipe" ||
      (connection.type === "directTcp" && !!connection.endpoint && isLoopback(connection.endpoint)),
  );
}

function relayUri(serverId: string, connection: AppConnection): string | null {
  const endpoint = connection.relayEndpoint;
  const key = connection.daemonPublicKeyB64;
  if (!endpoint || !key || !/:\d+$/.test(endpoint)) return null;
  const tls = connection.useTls ?? endpoint.endsWith(":443");
  return `relay://${endpoint}/${encodeURIComponent(serverId)}?key=${encodeURIComponent(key)}${tls ? "&ssl=true" : ""}`;
}

function sshUri(connection: AppConnection): string | null {
  const host = connection.host?.trim();
  if (!host || /\s/.test(host) || host.startsWith("-")) return null;
  const [user, name] = host.includes("@") ? host.split(/@(.*)/s, 2) : [null, host];
  if (!name) return null;
  const hostPart = name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
  const userPart = user ? `${encodeURIComponent(user)}@` : "";
  const port = connection.sshPort ? `:${connection.sshPort}` : "";
  return `ssh://${userPart}${hostPart}${port}?daemonPort=${connection.daemonPort ?? 6767}`;
}

/**
 * Picks how the daemon behind `target` should reach `host`, best option first: a relay offer
 * from the app, the host's own offer published by its mesh, a direct endpoint the target can
 * actually route to, then SSH with the target daemon user's keys. Loopback endpoints and local
 * sockets name the app's machine, so they only work for a target on that same machine.
 */
export function planConnection(
  host: AppHost,
  options: { targetOnAppMachine: boolean; publishedOffer: string | null },
): { connection: string; password?: string } | { skip: string } {
  const password =
    host.password ?? host.connections.find((connection) => connection.password)?.password;
  const withPassword = (connection: string) =>
    password ? { connection, password } : { connection };

  for (const connection of host.connections) {
    if (connection.type !== "relay") continue;
    const uri = relayUri(host.serverId, connection);
    if (uri) return withPassword(uri);
  }
  if (options.publishedOffer) return withPassword(options.publishedOffer);
  for (const connection of host.connections) {
    if (connection.type !== "directTcp" || !connection.endpoint) continue;
    if (isLoopback(connection.endpoint) && !options.targetOnAppMachine) continue;
    return withPassword(connection.useTls ? `wss://${connection.endpoint}` : connection.endpoint);
  }
  for (const connection of host.connections) {
    if (connection.type !== "remoteSsh") continue;
    const uri = sshUri(connection);
    if (uri) return withPassword(uri);
  }
  return {
    skip: options.targetOnAppMachine
      ? "the app reaches it only through a local socket or pipe"
      : "the app reaches it only from this machine; enable its relay or install mesh on it",
  };
}

export function planSync(input: {
  hosts: readonly AppHost[];
  targetServerId: string;
  targetOnAppMachine: boolean;
  publishedOffers: ReadonlyMap<string, string | null>;
}): { hosts: SyncedHost[]; skipped: SkippedHost[] } {
  const hosts: SyncedHost[] = [];
  const skipped: SkippedHost[] = [];
  const seen = new Set<string>();
  for (const host of input.hosts) {
    if (host.serverId === input.targetServerId || seen.has(host.serverId)) continue;
    seen.add(host.serverId);
    const label = host.label?.trim() || host.serverId;
    const plan = planConnection(host, {
      targetOnAppMachine: input.targetOnAppMachine,
      publishedOffer: input.publishedOffers.get(host.serverId) ?? null,
    });
    if ("skip" in plan) skipped.push({ label, reason: plan.skip });
    else hosts.push({ serverId: host.serverId, label, ...plan });
  }
  return { hosts, skipped };
}
