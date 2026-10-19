#!/usr/bin/env node
// Exercise the installed protocol's real validator without connecting to a daemon.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";

const MiB = 1024 * 1024;
const worker = process.argv[2] === "--worker";
const directory = path.resolve(process.argv[worker ? 3 : 2] ?? process.cwd());

if (worker) {
  const require = createRequire(path.join(directory, "package.json"));
  const { validateWSOutboundMessage } = await import(
    pathToFileURL(require.resolve("@getpaseo/protocol/validation/ws-outbound")).href
  );
  const initialRss = process.memoryUsage().rss;
  const session = (message) => ({ type: "session", message });
  const messages = [
    { type: "pong" },
    session({ type: "status", payload: { status: "server_info", serverId: "memory-probe" } }),
    session({
      type: "pong",
      payload: { requestId: "probe", serverReceivedAt: 1, serverSentAt: 2 },
    }),
    session({
      type: "subscription.release.response",
      payload: { requestId: "probe", subscriptionId: "probe" },
    }),
    session({ type: "agent_update", payload: { kind: "remove", agentId: "probe" } }),
    session({ type: "rpc_error", payload: { requestId: "probe", error: "probe" } }),
  ];
  for (const message of messages) {
    for (let i = 0; i < 2048; i++) {
      const result = validateWSOutboundMessage(message);
      if (!result.success) throw new Error("The validator rejected a valid probe message");
      // Let concurrent compilation finish before introducing another message shape.
      if (i === 511) await delay(500);
    }
    await delay(1000);
  }
  await delay(2000);
  global.gc();
  await delay(300);
  global.gc();
  console.log(
    JSON.stringify({
      messages: messages.length * 2048,
      initialRss,
      finalRss: process.memoryUsage().rss,
      maxRss: process.resourceUsage().maxRSS * 1024,
      peakCompilerAllocation: getHeapStatistics().peak_malloced_memory,
    }),
  );
} else {
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--maglev", fileURLToPath(import.meta.url), "--worker", directory],
    { encoding: "utf8", timeout: 60_000, maxBuffer: MiB },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`Memory probe exited with status ${result.status}`);
  }
  const measurement = JSON.parse(result.stdout.trim());
  const growth = measurement.maxRss - measurement.initialRss;
  const failures = [];
  if (growth > 512 * MiB) failures.push("resident memory grew by more than 512 MiB");
  if (measurement.peakCompilerAllocation > 256 * MiB) {
    failures.push("V8 native allocation exceeded 256 MiB");
  }
  console.log(
    JSON.stringify({
      messages: measurement.messages,
      initialRssMiB: +(measurement.initialRss / MiB).toFixed(1),
      finalRssMiB: +(measurement.finalRss / MiB).toFixed(1),
      maxRssMiB: +(measurement.maxRss / MiB).toFixed(1),
      peakCompilerAllocationMiB: +(measurement.peakCompilerAllocation / MiB).toFixed(1),
      failures,
    }),
  );
  if (failures.length) process.exitCode = 1;
}
