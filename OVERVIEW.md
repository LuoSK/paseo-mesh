Paseo Mesh lets agents on this host see and drive agents on your other Paseo hosts. An agent can list the agents on another machine, read their timelines, start new agents there, send follow-ups, answer their permission requests, and get a message when they finish, error or need permission.

## How it works

New agents on this host get a `mesh` MCP server served by the plugin on 127.0.0.1. The plugin keeps a connection to every peer you configure, either through the Paseo relay with end-to-end encryption or directly over WebSocket. Peers are ordinary Paseo daemons and do not need this plugin.

## Setup

Get a pairing offer on each machine you want to reach with `paseo daemon pair`, then add it under Settings, Plugins, mesh, Peers. Direct `host:port` connections work on Tailscale or a LAN; set a daemon password on the peer and enter it here.

Each peer is read-only by default. Grant write access to let agents create and control agents there, and add allowed paths to keep them in specific directories. Open Mesh in the sidebar to see every host and its agents.

Requires Paseo 0.11.0 or newer on this host.

## What it reads and stores

Offers and passwords are stored on this host in `paseo-mesh/config.json` under the Paseo home, readable only by the daemon user, and are never sent to the app. A pairing offer or password gives full control of that daemon; mesh enforces read and write access and allowed paths for its tools, but they are guardrails, not a sandbox.

## Limits

Only agents created after installation get the tools. Files are not shared between hosts. Pi agents do not get the tools because Pi does not accept MCP servers.
