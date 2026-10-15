import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MeshRuntime } from "./server/runtime";

export default function contribute(server: PluginServerContext) {
  const runtime = new MeshRuntime();
  runtime.register(server);
  void runtime.start();
  return () => runtime.stop();
}
