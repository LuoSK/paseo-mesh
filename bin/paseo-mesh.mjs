#!/usr/bin/env node
// paseo-mesh: manage the mesh plugin of a Paseo daemon from a terminal.
// Talks to the daemon the same way the paseo CLI does and calls the plugin's RPCs, so every
// change is validated and applied by the running plugin.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const PLUGIN_ID_DEFAULT = "mesh";
const APP_VERSION = "0.11.2";

const USAGE = `Usage: paseo-mesh <command> [options]

Commands:
  status                              Show hosts, connection state and agent tool settings
  peers add <name> <connection>       Add a peer (pairing offer URL, relay://, host:port, ws://, wss://)
  peers set <peer> [options]          Change a peer (by name or id)
  peers remove <peer>                 Remove a peer
  peers retry <peer>                  Reconnect now
  settings [--inject|--no-inject] [--local-access read|write] [--preapprove|--no-preapprove]

Peer options:
  --write | --read                    Access level (default for add: read)
  --allow-exec | --no-exec            Enable or disable shell execution (default: disabled)
  --password-stdin                    Read the peer's daemon password from stdin
  --clear-password                    Remove a stored password (set only)
  --allow <path>                      Allowed absolute path on that host (repeatable)
  --name <name>                       New name (set only)
  --connection <connection>           New connection (set only)
  --enable | --disable                Turn the peer on or off (set only)

Settings options:
  --local-allow-exec | --local-no-exec  Enable or disable local shell execution

Target daemon:
  --home <path>                       Local daemon home (default: $PASEO_HOME or ~/.paseo)
  --host <host:port>                  Daemon endpoint; password from $PASEO_PASSWORD
  --plugin <id>                       Installed plugin id (default: mesh)
  --json                              Print JSON
`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      host: { type: "string" },
      plugin: { type: "string", default: PLUGIN_ID_DEFAULT },
      json: { type: "boolean", default: false },
      write: { type: "boolean" },
      read: { type: "boolean" },
      "allow-exec": { type: "boolean" },
      "no-exec": { type: "boolean" },
      "local-allow-exec": { type: "boolean" },
      "local-no-exec": { type: "boolean" },
      "password-stdin": { type: "boolean" },
      "clear-password": { type: "boolean" },
      allow: { type: "string", multiple: true },
      name: { type: "string" },
      connection: { type: "string" },
      enable: { type: "boolean" },
      disable: { type: "boolean" },
      inject: { type: "boolean" },
      "no-inject": { type: "boolean" },
      preapprove: { type: "boolean" },
      "no-preapprove": { type: "boolean" },
      "local-access": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, sub, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const client = await connect(values);
  const rpc = (method, input) => client.invokePluginRpc(values.plugin, method, input);
  try {
    if (command === "status") {
      const status = await rpc("mesh.status", {});
      print(values.json, status, formatStatus);
      return 0;
    }
    if (command === "settings") {
      const injection = {};
      if (values.inject) injection.enabled = true;
      if (values["no-inject"]) injection.enabled = false;
      if (values.preapprove) injection.preapproveReadOnlyTools = true;
      if (values["no-preapprove"]) injection.preapproveReadOnlyTools = false;
      const localAccess = values["local-access"];
      if (localAccess && localAccess !== "read" && localAccess !== "write") {
        throw new Error("--local-access must be read or write");
      }
      const result = await rpc("mesh.settings.update", {
        ...(Object.keys(injection).length ? { injection } : {}),
        ...(localAccess ? { localAccess } : {}),
        ...(values["local-allow-exec"]
          ? { localAllowExec: true }
          : values["local-no-exec"]
            ? { localAllowExec: false }
            : {}),
      });
      print(values.json, result, (value) => JSON.stringify(value, null, 2));
      return 0;
    }
    if (command !== "peers") throw new UsageError(`Unknown command: ${command}`);

    if (sub === "add") {
      const [name, connection] = rest;
      if (!name || !connection) throw new UsageError("peers add needs <name> <connection>");
      const password = values["password-stdin"] ? await readStdin() : undefined;
      const peer = await rpc("mesh.peers.add", {
        name,
        connection,
        ...(password ? { password } : {}),
        access: values.write ? "write" : "read",
        allowExec: values["allow-exec"] ?? false,
        allowedPaths: values.allow ?? [],
      });
      print(values.json, peer, (value) => `Added ${value.name} (${value.id}): ${value.status}`);
      return 0;
    }

    const [ref] = rest;
    if (!ref) throw new UsageError(`peers ${sub ?? ""} needs a peer name or id`);
    const peer = await findPeer(rpc, ref);
    if (sub === "remove") {
      await rpc("mesh.peers.remove", { id: peer.id });
      print(values.json, { removed: peer.id }, () => `Removed ${peer.name}`);
      return 0;
    }
    if (sub === "retry") {
      const result = await rpc("mesh.peers.retry", { id: peer.id });
      print(values.json, result, (value) => `${value.name}: ${value.status}`);
      return 0;
    }
    if (sub === "set") {
      const password = values["password-stdin"] ? await readStdin() : undefined;
      const update = {
        id: peer.id,
        ...(values.name ? { name: values.name } : {}),
        ...(values.connection ? { connection: values.connection } : {}),
        ...(values.write ? { access: "write" } : values.read ? { access: "read" } : {}),
        ...(values["allow-exec"]
          ? { allowExec: true }
          : values["no-exec"]
            ? { allowExec: false }
            : {}),
        ...(values.allow ? { allowedPaths: values.allow } : {}),
        ...(values.enable ? { enabled: true } : values.disable ? { enabled: false } : {}),
        ...(values["clear-password"] ? { password: null } : password ? { password } : {}),
      };
      const result = await rpc("mesh.peers.update", update);
      print(values.json, result, (value) => `Updated ${value.name}: ${value.status}`);
      return 0;
    }
    throw new UsageError(`Unknown peers command: ${sub ?? ""}`);
  } finally {
    await client.close().catch(() => {});
  }
}

class UsageError extends Error {}

async function connect(values) {
  let url;
  let password;
  let localCredential;
  if (values.host) {
    url = values.host.startsWith("ws") ? values.host : `ws://${values.host}/ws`;
    password = process.env.PASEO_PASSWORD || undefined;
  } else {
    const home = values.home ?? process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
    let pid;
    try {
      pid = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
    } catch {
      throw new Error(`No running daemon found in ${home}. Start it with: paseo daemon start`);
    }
    const listen = String(pid.listen ?? "");
    const match = /^(.*):(\d+)$/.exec(listen);
    if (!match) throw new Error(`The daemon listens on ${listen}; use --host for socket daemons`);
    const host = !match[1] || match[1] === "0.0.0.0" ? "127.0.0.1" : match[1];
    url = `ws://${host}:${match[2]}/ws`;
    localCredential = async () => {
      try {
        return (await readFile(path.join(home, "local-credential"), "utf8")).trim() || undefined;
      } catch {
        return undefined;
      }
    };
  }
  const client = new DaemonClient({
    url,
    clientId: `paseo-mesh-cli-${process.pid}`,
    clientType: "cli",
    appVersion: APP_VERSION,
    reconnect: { enabled: false },
    ...(password ? { password } : {}),
    ...(localCredential ? { localCredential } : {}),
  });
  try {
    await client.connect();
    await client.fetchAgents({ page: { limit: 1 } });
  } catch (error) {
    await client.close().catch(() => {});
    throw new Error(`Cannot connect to the daemon at ${url}: ${messageOf(error)}`);
  }
  return client;
}

async function findPeer(rpc, ref) {
  const status = await rpc("mesh.status", {});
  const peers = status.hosts.filter((host) => !host.local);
  const peer = peers.find((host) => host.id === ref || host.name === ref.toLowerCase());
  if (!peer) {
    throw new Error(
      `Unknown peer "${ref}". Peers: ${peers.map((host) => host.name).join(", ") || "(none)"}`,
    );
  }
  return peer;
}

async function readStdin() {
  if (process.stdin.isTTY) throw new Error("--password-stdin expects the password on stdin");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (!value) throw new Error("No password on stdin");
  return value;
}

function formatStatus(status) {
  const lines = [`paseo-mesh ${status.version}`];
  if (status.configError) lines.push(`Config not applied: ${status.configError}`);
  if (status.mcp.error) lines.push(`MCP server failed: ${status.mcp.error}`);
  lines.push("", "HOST                 STATUS      ACCESS  SERVER ID              CONNECTION");
  for (const host of status.hosts) {
    lines.push(
      `${host.name.padEnd(20)} ${host.status.padEnd(11)} ${host.access.padEnd(7)} ${String(host.serverId ?? "-").padEnd(22)} ${host.endpoint}`,
    );
    if (host.error) lines.push(`${"".padEnd(21)}${host.error}`);
  }
  lines.push(
    "",
    `Agent tools: ${status.injection.enabled ? "on" : "off"} · read-only preapproval: ${status.injection.preapproveReadOnlyTools ? "on" : "off"}`,
    `Pending notifications: ${status.watches}`,
    `MCP endpoint: ${status.mcp.url ?? "not running"}`,
    `Data: ${status.dataDirectory}`,
  );
  return lines.join("\n");
}

function print(json, value, format) {
  process.stdout.write(`${json ? JSON.stringify(value, null, 2) : format(value)}\n`);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`paseo-mesh: ${messageOf(error)}\n`);
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
