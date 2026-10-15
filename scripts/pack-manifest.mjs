#!/usr/bin/env node
// Prepares the published package. `prepack` removes the Git-only `npm ci` build step from the
// manifest (npm installs dependencies itself) and writes npm-shrinkwrap.json so those
// dependencies are locked; `postpack` restores the manifest and removes the shrinkwrap, which
// would otherwise take precedence over package-lock.json for Git installs and development.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { buildShrinkwrap } from "./shrinkwrap.mjs";

const manifest = new URL("../paseo-plugin.json", import.meta.url);
const backup = new URL("../paseo-plugin.json.orig", import.meta.url);
const shrinkwrap = new URL("../npm-shrinkwrap.json", import.meta.url);
const mode = process.argv[2];

if (mode === "strip") {
  if (existsSync(backup)) renameSync(backup, manifest);
  const original = readFileSync(manifest, "utf8");
  const parsed = JSON.parse(original);
  delete parsed.build;
  writeFileSync(backup, original);
  writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  writeFileSync(shrinkwrap, `${JSON.stringify(buildShrinkwrap(pkg, lock), null, 2)}\n`);
} else if (mode === "restore") {
  if (existsSync(backup)) renameSync(backup, manifest);
  rmSync(shrinkwrap, { force: true });
} else {
  console.error("Usage: pack-manifest.mjs strip|restore");
  process.exit(2);
}
