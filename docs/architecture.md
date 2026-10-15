# Architecture

paseo-mesh is one Paseo plugin with a server entry (runs in the plugin subprocess on the daemon host) and a client entry (runs inside the Paseo app). This document records why the pieces are shaped the way they are. For behavior from a user's point of view, see the [README](../README.md).

## Components

| Module | Owns |
| --- | --- |
| `server/runtime.ts` | Wiring: data directory, stores, RPC handlers, lifecycle hooks, MCP server start |
| `server/host-registry.ts` | `local` plus one `PeerConnection` per configured peer; host resolution; uniform `HostOps` |
| `server/peer-connection.ts` | One supervised connection to a remote daemon: connect, verify identity, reconnect |
| `server/connection-target.ts` | Parsing offers, `relay://` URIs and direct endpoints into WebSocket targets |
| `server/local-connection.ts` | Reaching the plugin's own daemon outside hook and RPC calls |
| `server/mcp-http.ts` | Minimal MCP server over Streamable HTTP |
| `server/tools.ts` | The `mesh_*` tools |
| `server/watches.ts` | Persisted finish notifications for remote work |
| `server/callers.ts` | Mapping MCP callers to local agent IDs |
| `server/json-store.ts` | Atomic, owner-only JSON files with external-edit watching |
| `client/` | Mesh screen and Peers settings |
| `bin/paseo-mesh.mjs` | CLI that calls the plugin RPCs |

## Data directory

`$PASEO_MESH_HOME`, or `$PASEO_HOME/paseo-mesh`:

| File | Content |
| --- | --- |
| `config.json` | Peers (including offers and passwords), access, injection settings |
| `server.json` | MCP port and bearer token |
| `callers.json` | Caller nonce → local agent ID |
| `watches.json` | Pending finish notifications |

All files are written atomically with mode 0600. Mesh does not use Paseo's plugin settings store for peers because settings documents are returned in full to any client that reads them, and peers carry credentials.

## Why the plugin runs its own MCP server

Paseo lets a plugin change an agent's configuration in `before("agent.create")`, including `mcpServers`, but offers no way to add tools to the daemon's own `paseo` MCP server. Mesh therefore serves its tools from the plugin subprocess and injects an `http` MCP entry named `mesh`.

The injected entry is persisted with the agent record and is not re-evaluated on resume (`agent.session_open` can only change env). Two consequences:

- The URL must stay valid across restarts. The port is derived from a hash of `PASEO_HOME` on first start and saved in `server.json`, together with the token. Only when that port is taken by another program does mesh pick a new one, which breaks the tools of agents created earlier.
- Injection only reaches agents created after installation.

Injection is skipped for providers in `excludeProviders` (Pi rejects agents with MCP servers). Read-only tools are preapproved through `toolPolicy` only for providers in `preapproveProviders`; Paseo rejects any tool policy for providers without exact MCP preapproval support, which would make agent creation fail.

## Caller identity

Finish notifications need the local agent that called a tool. MCP requests carry no agent identity, and `agent.create` runs before the daemon assigns an agent ID. Mesh issues a random nonce in `agent.create`, puts it in both the MCP URL (`?caller=<nonce>`) and the create `env` (`PASEO_MESH_CALLER`), and binds it to the agent ID when `agent.session_open` sees that env. The binding is persisted because the nonce lives on in the stored MCP URL while the env does not. A nonce binds once; unbound nonces are pruned after a day.

A config copied from another agent (a schedule, for example) carries that agent's mesh URL and nonce. The create hook recognizes its own endpoint and issues a fresh nonce, so the new agent never acts as the original. A `mesh` server that is not this plugin's is left alone.

Tool calls without a bound caller still work; they just cannot arm notifications. `callers.json` drops unbound nonces after a day and keeps at most 5,000 entries.

## Peer connections

Each peer gets a `DaemonClient` from `@getpaseo/client`, wrapped with `createPaseoApi`. The public `createPaseoClient` is not used because mesh needs `getLastServerInfoMessage` (identity), `cancelAgent` and the server-side `waitForFinish`, which only the internal client exposes.

The client's own reconnect is disabled. On any disconnect the connection is torn down and a fresh client is built after exponential backoff. Every connection re-verifies identity:

- For relay targets, the handshake's `serverId` must equal the offer's.
- A peer reaching this daemon's own `serverId` is a self loop.
- A peer reaching a daemon already online under another peer is a duplicate.

A generation counter discards results of connects that were superseded by a config change or close, and a closed peer never restarts. Duplicate detection compares against peers that are online or have just claimed a server ID: validation and the claim happen without an `await` in between, so of two peers reaching the same daemon at the same moment, exactly one wins.

Config is applied as a diff keyed by the stable peer `id`. Name, access and allowed-path changes are applied in place. Connection, password and enablement changes reconnect.

## The local daemon

Paseo hands plugin code a `PaseoApi` only inside hook and RPC calls. Tool calls from agents and notifications for remote work can happen before any such call, for example right after a plugin reload. `LocalConnection` uses the API from a hook or handler when it has one, and otherwise connects to the daemon the way the CLI does: the listen address from `$PASEO_HOME/paseo.pid` and the credential from `$PASEO_HOME/local-credential`. Daemons that listen only on a Unix socket are not reachable this way.

## Watches

A watch is `(hostId, serverId, agentId, notifyAgentId)`. Its runner loops:

1. Resolve the host by peer id, then by `serverId`. If neither resolves, record `orphanedAt` on the watch and wait for the daemon to come back under any peer. After 24 hours, counted from the persisted time so restarts do not reset it, tell the caller and give up.
2. Get the host's operations. Any failure here (peer offline, local daemon unreachable) is waited out; peer connections wake waiting runners.
3. Call the daemon's `waitForFinish` in 5-minute chunks, raced against the runner's abort signal so plugin shutdown never waits on it. The daemon returns immediately when the agent is idle, so a turn that ended during a disconnect is reported after reconnecting.
4. On `permission`, notify once per request ID and keep polling with backoff (3 to 30 seconds) while it stays pending. On `idle` or `error`, notify and delete the watch. The daemon answers a wait for a deleted agent with an error and no snapshot; mesh confirms the agent is gone and tells the caller so instead of reporting an error.

Delivery is at least once. A failed delivery is retried with backoff and the watch is only deleted after the caller was notified or is gone (deleted or archived). Permission IDs are recorded only after their notification was delivered. A plugin stop during delivery keeps the watch on disk, so it can be delivered again after the restart.

Notifications are sent to the caller with `activeTurnBehavior: "steer"`, like Paseo's own. Re-arming the same agent for the same caller replaces the earlier watch.

## Testing

Unit tests cover pure modules. The end-to-end suite (`test/e2e`) starts real daemons from `@getpaseo/cli` with temporary homes and ports, installs the plugin and a deterministic echo provider (`test/fixtures/echo-provider`), and drives everything through the real MCP endpoint, plugin RPCs and the CLI. The echo provider understands `SLEEP`, `FAIL`, `PERMIT`, `ENV` and `MCP` prompts, so timing, failures, permissions, env injection and tool calls from inside an agent can be tested without a model.
