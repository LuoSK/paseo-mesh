# Releasing the maintained fork

This fork is distributed through `LuoSK/paseo-mesh`, not npm. `package.json` is private to prevent accidental publication under the upstream package name. Retain the upstream MIT license and attribution.

## Prepare a version

1. Use a fork-specific version such as `0.2.1-blinklab.1` in `package.json` and `shared/version.ts`, and document the changes in `CHANGELOG.md`.
2. Keep the runtime client/protocol and development CLI/plugin packages on the same reviewed Paseo version. Keep `PASEO_CLIENT_APP_VERSION` and the CLI's `APP_VERSION` aligned with that client version. Refresh and commit `package-lock.json` with npm 10 or 11.
3. Check `requirements.paseo` and the documented daemon/app minimum before adopting new SDK behavior.
4. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:memory`, `npm run test:e2e`, and `npm run check:package`.
5. Create an artifact with `npm pack --pack-destination /path/to/artifacts`. The packing hooks produce a runtime-only `npm-shrinkwrap.json`, remove the Git-only preparation step from the packed manifest, and restore the source manifest afterward. Do not commit the generated shrinkwrap or archives.
6. Initialize a temporary consumer project with `npm init -y`, install the archive there using `npm install --omit=dev --ignore-scripts /path/to/artifact.tgz`, and run `node scripts/check-memory.mjs /path/to/consumer/node_modules/paseo-mesh` from the source checkout. This tests the published shrinkwrap as a dependency. Do not run `npm ci` in the extracted package root: its runtime-only shrinkwrap deliberately excludes the development dependencies still declared in the package metadata. Never use a production Paseo home for package checks.

The memory regression check uses synthetic messages and forces Maglev only in an isolated child process. The first maintenance fix moves to Paseo 0.12.0's per-message validators; it does not disable optimization in production or modify generated dependency code.

## Commit and distribute

Push only reviewed source, tests, documentation, workflows and the lockfile. Never include pairing offers, host configuration, passwords, agent histories or runtime state.

The inherited GitHub workflows are unchanged because the current GitHub credential has no `workflow` permission. Run the memory check and archive-installation check manually before every dependency update. Do not push version tags from this fork: the inherited Release workflow still targets upstream npm publishing, and this fork's private package flag intentionally blocks that operation. Build and retain the verified archive manually; no npm publication or automatic artifact release is configured for this maintenance version.

Fresh Git installation from a reviewed revision:

```bash
paseo plugin install git:LuoSK/paseo-mesh --ref <commit-or-tag> --id mesh
```

Keep the `mesh` installation ID and existing `PASEO_HOME`. Paseo rejects installing over an existing ID. For a source migration, privately back up the current installation and state, run `paseo plugin remove mesh`, and then run the installation command above. Removal clears the managed plugin and generic plugin settings; Mesh stores its peers, caller identities and preferred MCP port separately in `$PASEO_HOME/paseo-mesh/`. Do not delete or recreate that directory. If the new installation fails, reinstall the privately backed-up old source under the same ID. A cutover briefly interrupts Mesh requests and notifications; obtain approval before changing a running installation. No daemon restart is needed.

After installation, require `running` in `paseo plugin ls`, verify the installed source revision and runtime dependency versions, exercise local tools and an authorized reachable peer, and observe the new plugin process's memory after traffic. Do not treat a fresh process's low initial memory as proof of the fix.

## Follow upstream

Keep `upstream` pointing to `https://github.com/jtsang4/paseo-mesh.git`. Review upstream changes before merging them into the fork, preserving its lockfile, manual memory regression and private-package policy. The inherited compatibility workflow tests newer Paseo dependencies without changing the reviewed production lock; it does not automatically deploy them or run this fork's new memory check.
