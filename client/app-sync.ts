import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { describeSelfRpc, syncPeersRpc } from "../shared/rpc";
import {
  APP_ID_KEY,
  APP_REGISTRY_KEY,
  type AppHost,
  isOnAppMachine,
  parseAppRegistry,
  planSync,
} from "../shared/sync";

// Keeps this host's mesh peers in step with the app's Hosts list. Every host running mesh
// has its own plugin installation inside the app, and each installation syncs only its own
// daemon. Installations find each other through a registry on globalThis, so a host the app
// reaches only locally (this laptop, say) can still hand its own pairing offer to the others.

const INTERVAL_MS = 30_000;
const RESEND_MS = 10 * 60_000;
const OFFER_TTL_MS = 5 * 60_000;
const REGISTRY = Symbol.for("paseo-mesh.installations");

interface Installation {
  describe(): Promise<{ serverId: string | null; offerUrl: string | null }>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  if (Platform.OS !== "web") return null;
  return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
}

function installations(): Map<object, Installation> {
  const scope = globalThis as unknown as Record<symbol, Map<object, Installation> | undefined>;
  scope[REGISTRY] ??= new Map();
  return scope[REGISTRY];
}

function appId(store: StorageLike): string {
  const existing = store.getItem(APP_ID_KEY);
  if (existing && /^[a-z0-9-]{8,64}$/.test(existing)) return existing;
  const id = `app-${Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("")}`;
  store.setItem(APP_ID_KEY, id);
  return id;
}

/** Runs a sync for this installation now; undefined where the app cannot sync. */
export let syncNow: (() => Promise<void>) | undefined;

/** Whether this app can read its host list (desktop and web). */
export function canSyncAppHosts(): boolean {
  return storage() !== null;
}

export function startAppSync(client: PluginClientContext): () => void {
  const store = storage();
  if (!store) return () => {};
  const self: Installation = {
    describe: () => client.rpc(describeSelfRpc, {}),
  };
  const key = {};
  installations().set(key, self);

  const offers = new Map<
    object,
    { at: number; serverId: string | null; offerUrl: string | null }
  >();
  let lastSent = "";
  let lastSentAt = 0;
  let running: Promise<void> | null = null;
  let stopped = false;

  async function publishedOffers(): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    for (const [other, installation] of installations()) {
      if (other === key) continue;
      let cached = offers.get(other);
      if (!cached || Date.now() - cached.at > OFFER_TTL_MS) {
        try {
          const described = await installation.describe();
          cached = { at: Date.now(), ...described };
          offers.set(other, cached);
        } catch {
          continue; // That host is offline or its mesh is reloading; use the app's data only.
        }
      }
      if (cached.serverId) result.set(cached.serverId, cached.offerUrl);
    }
    return result;
  }

  async function cycle(force: boolean): Promise<void> {
    const described = await client.rpc(describeSelfRpc, {});
    if (!described.appSyncEnabled || !described.serverId || !store) return;
    let hosts: AppHost[];
    try {
      hosts = parseAppRegistry(store.getItem(APP_REGISTRY_KEY));
    } catch (error) {
      await client.rpc(syncPeersRpc, {
        appId: appId(store),
        hosts: [],
        skipped: [],
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const target = hosts.find((host) => host.serverId === described.serverId);
    const plan = planSync({
      hosts,
      targetServerId: described.serverId,
      targetOnAppMachine: target ? isOnAppMachine(target) : false,
      publishedOffers: await publishedOffers(),
    });
    const fingerprint = JSON.stringify(plan);
    if (!force && fingerprint === lastSent && Date.now() - lastSentAt < RESEND_MS) return;
    await client.rpc(syncPeersRpc, { appId: appId(store), ...plan });
    lastSent = fingerprint;
    lastSentAt = Date.now();
  }

  function run(force: boolean): Promise<void> {
    running ??= cycle(force)
      .catch((error) => {
        console.warn("[mesh] app host sync failed", error);
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  syncNow = () => run(true);
  const first = setTimeout(() => void run(false), 2_000);
  const timer = setInterval(() => {
    if (!stopped) void run(false);
  }, INTERVAL_MS);

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    installations().delete(key);
    syncNow = undefined;
  };
}
