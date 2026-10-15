# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-15

### Added

- `mesh` MCP server injected into new agents, with `mesh_list_hosts`, `mesh_list_workspaces`, `mesh_list_agents`, `mesh_get_agent`, `mesh_read_timeline`, `mesh_list_providers`, `mesh_create_agent`, `mesh_send_prompt`, `mesh_wait_agent`, `mesh_respond_permission`, `mesh_stop_agent` and `mesh_archive_agent`.
- Peers over pairing offers, `relay://` URIs (end-to-end encrypted relay) and direct `host:port` / `ws://` / `wss://` connections with optional daemon passwords.
- Identity checks for every connection: offer/server mismatch, self loops and duplicate peers.
- Supervised reconnects with exponential backoff; config changes applied as a diff keyed by stable peer IDs, so renames keep connections and pending work.
- Finish, error and permission notifications for remote agents, persisted across plugin reloads, daemon restarts, disconnects and peer removal.
- Per-peer read/write access and allowed paths.
- Mesh screen, Peers settings screen and Command Center entries in the Paseo app.
- `paseo-mesh` CLI for headless peer management.

[Unreleased]: https://github.com/jtsang4/paseo-mesh/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jtsang4/paseo-mesh/releases/tag/v0.1.0
