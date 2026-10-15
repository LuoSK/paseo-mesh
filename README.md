# paseo-mesh

A [Paseo](https://paseo.sh) plugin that lets agents on one Paseo host see and drive agents on your other hosts.

Paseo's built-in orchestration (`create_agent`, `send_agent_prompt`, finish notifications) works inside one daemon. paseo-mesh extends it across machines: an agent on your laptop can list the agents on your GPU box, read their timelines, start new agents there, send follow-ups, answer their permission requests, and get a message when they finish.

[中文说明](README.zh-CN.md)

```
laptop (paseo-mesh installed)                    gpu-box, office-mac (plain Paseo)
┌────────────────────────────────────┐
│ agent ── mesh MCP tools ──► plugin │── relay (E2EE) or direct WebSocket ──► daemon
│                             │      │──────────────────────────────────────► daemon
│      ◄── "agent X finished" ┘      │
└────────────────────────────────────┘
```

Only the orchestrating host needs the plugin. Peers are ordinary Paseo daemons you can pair with.

## Features

- **Mesh tools for agents.** New agents on the host get a `mesh` MCP server with `mesh_list_hosts`, `mesh_list_workspaces`, `mesh_list_agents`, `mesh_get_agent`, `mesh_read_timeline`, `mesh_list_providers`, `mesh_create_agent`, `mesh_send_prompt`, `mesh_wait_agent`, `mesh_respond_permission`, `mesh_stop_agent` and `mesh_archive_agent`.
- **Finish notifications across hosts.** When an agent starts or prompts a remote agent, it receives a message when that agent finishes, errors or asks for permission, in the same format as Paseo's own notifications.
- **Any connection Paseo supports.** Pairing offer URLs and `relay://` URIs (end-to-end encrypted through the Paseo relay, no open ports), or direct `host:port` / `ws://` / `wss://` with an optional daemon password (Tailscale, LAN, reverse proxy).
- **Per-host access control.** Each peer is read-only or read-write, optionally limited to allowed paths: agents can only create, prompt, stop, archive or answer permissions for agents under those paths.
- **App screens.** A Mesh screen with host status and agents across hosts, and a Peers settings screen to add, edit and remove peers.
- **Headless management.** A `paseo-mesh` CLI for daemons without the app.

## Requirements

- Paseo daemon 0.11.0 or newer on the orchestrating host, with plugins enabled.
- Peers: any Paseo daemon the orchestrating host can reach through the relay or directly.
- Node.js and npm on the orchestrating host for Git installs (Paseo runs `npm ci --omit=dev` to install the plugin's dependencies).

## Install

Plugins run unsandboxed with the daemon user's access. Install only code you trust.

1. Enable plugins on the orchestrating host: **Settings → Plugins → Enable plugins** in the app, or set `"pluginsEnabled": true` in `~/.paseo/config.json` and run `paseo reload`.
2. Install from GitHub:

   ```bash
   paseo plugin add git:jtsang4/paseo-mesh
   ```

   or, once a release is on npm, `paseo plugin install npm:paseo-mesh`.

3. Check it is running:

   ```bash
   paseo plugin ls
   paseo plugin logs mesh
   ```

Update later with `paseo plugin update mesh`.

## Connect your hosts

On each machine you want to reach, get a pairing offer:

```bash
paseo daemon pair            # prints https://app.paseo.sh/#offer=...
```

Treat the offer like a password: it lets its holder control that daemon. Then add the peer on the orchestrating host, either in the app (**Settings → Plugins → mesh → Peers → Add a peer**) or from a terminal:

```bash
npx github:jtsang4/paseo-mesh peers add gpu-box 'https://app.paseo.sh/#offer=...' --write
npx github:jtsang4/paseo-mesh peers add office-mac 100.64.0.7:6767 --password-stdin < password.txt
npx github:jtsang4/paseo-mesh status
```

| Connection | Use it when |
| --- | --- |
| `https://app.paseo.sh/#offer=…` or `relay://…` | The peer can reach the internet. Works behind NAT and firewalls; traffic is end-to-end encrypted. Self-hosted relays work too: the offer carries the relay address. |
| `host:port`, `ws://…`, `wss://…` | The hosts share a network (Tailscale, LAN, VPN, reverse proxy). Set a daemon password on the peer and give it to mesh. |
| SSH | Forward the port yourself (`ssh -N -L 7767:127.0.0.1:6767 box`) and add `127.0.0.1:7767`. |

Peers default to **read** access. Grant **write** to let agents create and control agents there, and add allowed paths to keep them in specific directories.

## Use it

Agents created after installation have the mesh tools. Ask them in plain language:

> Start a codex agent on gpu-box in /srv/models/llm to run the eval suite, and tell me the summary when it's done.

> What are the agents on office-mac doing right now?

> Read the last messages of the review agent on gpu-box and send it my comments.

The agent calls `mesh_create_agent` and gets on with other work. When the remote agent finishes, the caller receives a message like:

```
[paseo-mesh] Agent 3f2c… (eval-suite) on host gpu-box (srv_…) finished.
<agent-response>
All 412 cases passed …
</agent-response>
```

Open **Mesh** in the app sidebar to see every host and its agents. Agents on hosts that the app is also connected to open directly.

### Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `mesh_list_hosts` | read | Hosts, status, identity and access level |
| `mesh_list_workspaces` | read | Workspaces and paths on a host |
| `mesh_list_agents` | read | Agents on one host or all hosts; unreachable hosts are reported, not fatal |
| `mesh_get_agent` | read | Status, pending permissions, last assistant message |
| `mesh_read_timeline` | read | Recent messages and tool calls |
| `mesh_list_providers` | read | Providers, models and modes available on a host |
| `mesh_wait_agent` | read | Block until a turn finishes, with a timeout |
| `mesh_create_agent` | write | Start an agent on a host with a first task |
| `mesh_send_prompt` | write | Send a follow-up (steer or interrupt a running turn) |
| `mesh_respond_permission` | write | Allow or deny a remote permission request |
| `mesh_stop_agent` | write | Cancel a remote agent's running turn |
| `mesh_archive_agent` | write | Archive an agent on a host |

Hosts are addressed by name, peer id or daemon `serverId`; `local` is the orchestrating host. Agents are identified by `(host, agentId)`. Read-only tools run without a permission prompt for Claude, Codex and OpenCode; write tools follow the agent's normal permission mode.

## How it behaves when hosts change

| Event | Behavior |
| --- | --- |
| Peer renamed | Connection stays up. Pending notifications follow the peer and use the new name. Old names stop resolving; peer ids and server ids keep working. |
| Connection, password or enablement changed | The peer reconnects with the new settings. |
| Peer offline, daemon restarted, network drop | Exponential backoff reconnect (1 s to 30 s with jitter). Pending notifications wait and resume after the reconnect; turns that ended in the meantime are reported. |
| Peer removed | Pending notifications are kept. If the same daemon is added back under any name within 24 hours, they resume. Otherwise the caller is told why they stopped. |
| Remote agent deleted | The caller is told the agent no longer exists. |
| Calling agent archived or deleted | The notification is dropped. |
| Peer points back to this daemon | Rejected as a self loop. |
| Two peers reach the same daemon | The second is flagged as a duplicate until the first is removed. |
| Wrong offer for a daemon | Rejected: the handshake's server id must match the offer. |
| Plugin reloaded or daemon restarted | Peers reconnect, pending notifications are restored from disk, and the MCP endpoint keeps the same port and token so existing agents keep their tools. |
| `config.json` edited by hand | Applied on save. Peers without an id get one. An invalid file is reported in status and the last valid config stays active. |

## Security

- **Trust boundary.** A pairing offer or daemon password gives full control of that daemon. Paseo does not issue scoped credentials yet, so mesh enforces read/write access and allowed paths itself. They are guardrails for agents, not a sandbox: symlinks on the peer are not resolved.
- **Secrets stay on the host.** Offers and passwords live in `$PASEO_HOME/paseo-mesh/config.json` (mode 0600). RPCs and the status screen never return them.
- **Local endpoint.** The MCP server listens on `127.0.0.1` with a random bearer token stored in `$PASEO_HOME/paseo-mesh/server.json` (0600). It is injected into agents' MCP config, which Paseo keeps in the agent record.
- **Relay.** Relay traffic uses Paseo's end-to-end encryption; the relay sees only metadata. See Paseo's [security model](https://github.com/getpaseo/paseo/blob/main/SECURITY.md).

## Configuration

Everything is editable in the app. The underlying file is `$PASEO_HOME/paseo-mesh/config.json`:

```json
{
  "version": 1,
  "localAccess": "write",
  "injection": {
    "enabled": true,
    "excludeProviders": ["pi"],
    "preapproveReadOnlyTools": true,
    "preapproveProviders": ["claude", "codex", "opencode"]
  },
  "peers": [
    {
      "name": "gpu-box",
      "connection": "https://app.paseo.sh/#offer=...",
      "access": "write",
      "allowedPaths": ["/srv/models"],
      "enabled": true
    }
  ]
}
```

| Setting | Meaning |
| --- | --- |
| `localAccess` | What mesh tools may do on the orchestrating host itself |
| `injection.enabled` | Give new agents the mesh MCP server |
| `injection.excludeProviders` | Providers that cannot take MCP servers (Pi rejects them) |
| `injection.preapproveReadOnlyTools` | Skip permission prompts for read-only mesh tools |
| `injection.preapproveProviders` | Providers that support exact MCP tool preapproval |

Set `PASEO_MESH_HOME` to move the data directory.

## CLI

```text
paseo-mesh status
paseo-mesh peers add <name> <connection> [--write] [--password-stdin] [--allow <path>]...
paseo-mesh peers set <peer> [--name <name>] [--connection <c>] [--read|--write] [--enable|--disable]
                             [--password-stdin|--clear-password] [--allow <path>]...
paseo-mesh peers remove <peer>
paseo-mesh peers retry <peer>
paseo-mesh settings [--inject|--no-inject] [--preapprove|--no-preapprove] [--local-access read|write]
```

Run it with `npx github:jtsang4/paseo-mesh <command>` (or `npx paseo-mesh` once a release is on npm). Target another daemon with `--home <path>` or `--host <host:port>` (password from `PASEO_PASSWORD`). Add `--json` for machine-readable output.

## Limitations

- Agents created before mesh was installed do not have the tools. Create a new agent to use them.
- Files are not shared between hosts. Hand work over through git or messages.
- Stopping turns on the local host is left to Paseo's own `cancel_agent` tool.
- Running two installations of mesh on the same daemon is not supported; they would share one data directory.
- When the stored MCP port is taken by another program at startup, mesh moves to a new port and agents created earlier lose their mesh tools.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test               # unit tests
npm run test:e2e       # starts isolated daemons from @getpaseo/cli; never touches ~/.paseo
MESH_E2E_RELAY=1 npm run test:e2e   # also exercise relay.paseo.sh
```

The end-to-end suite runs real daemons with a deterministic echo provider (`test/fixtures/echo-provider`), so it needs no model credentials. See [docs/architecture.md](docs/architecture.md) for internals and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

To try a working copy on a disposable daemon (a fresh home defaults to port 6767, so pick another one first):

```bash
npx paseo daemon config set daemon.listen 127.0.0.1:7777 --home /tmp/mesh-dev
npx paseo daemon config set pluginsEnabled true --home /tmp/mesh-dev
npx paseo daemon start --home /tmp/mesh-dev
npx paseo --home /tmp/mesh-dev plugin install "$PWD"
npx paseo --home /tmp/mesh-dev plugin reload mesh   # after edits
npx paseo daemon stop --home /tmp/mesh-dev
```

## License

[MIT](LICENSE)
