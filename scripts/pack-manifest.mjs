#!/usr/bin/env node
// npm installs get production dependencies from npm itself, and the published package has no
// lockfile for the Git-only `npm ci` preparation step. `prepack` removes `build` from the
// manifest that goes into the tarball; `postpack` restores the original.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const manifest = new URL("../paseo-plugin.json", import.meta.url);
const backup = new URL("../paseo-plugin.json.orig", import.meta.url);
const mode = process.argv[2];

if (mode === "strip") {
  if (existsSync(backup)) renameSync(backup, manifest);
  const original = readFileSync(manifest, "utf8");
  const parsed = JSON.parse(original);
  delete parsed.build;
  writeFileSync(backup, original);
  writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
} else if (mode === "restore") {
  if (existsSync(backup)) renameSync(backup, manifest);
} else {
  console.error("Usage: pack-manifest.mjs strip|restore");
  process.exit(2);
}
