import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createEchoProvider } from "./server/provider";

// Test-only provider used by paseo-mesh e2e tests. It needs no model or credentials.
export default function contribute(server: PluginServerContext) {
  server.registerProvider(createEchoProvider());
  return () => {};
}
