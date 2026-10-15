#!/usr/bin/env node
// Packs the plugin and checks what an npm install would receive.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-pack-"));
try {
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
    encoding: "utf8",
  });
  const [{ filename, files }] = JSON.parse(out);
  const paths = files.map((file) => file.path);
  const required = [
    "paseo-plugin.json",
    "OVERVIEW.md",
    "index.server.ts",
    "index.client.tsx",
    "bin/paseo-mesh.mjs",
  ];
  const missing = required.filter((file) => !paths.includes(file));
  const forbidden = paths.filter((file) =>
    /\.test\.tsx?$|^test\/|^scripts\/|^\.github\//.test(file),
  );
  execFileSync("tar", ["-xzf", path.join(dir, filename), "-C", dir]);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package", "paseo-plugin.json"), "utf8"));
  const problems = [
    ...missing.map((file) => `missing ${file}`),
    ...forbidden.map((file) => `unexpected ${file}`),
    ...("build" in manifest ? ["published manifest still declares the Git-only build step"] : []),
  ];
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const shrinkwrap = JSON.parse(
    readFileSync(path.join(dir, "package", "npm-shrinkwrap.json"), "utf8"),
  );
  const locked = Object.entries(shrinkwrap.packages).filter(([location]) => location);
  for (const name of Object.keys(pkg.dependencies)) {
    if (!shrinkwrap.packages[`node_modules/${name}`]) problems.push(`shrinkwrap misses ${name}`);
  }
  for (const [location, entry] of locked) {
    if (!entry.resolved || !entry.integrity) problems.push(`${location} is not pinned`);
    if (entry.dev) problems.push(`${location} is a dev dependency`);
  }
  if (existsSync(new URL("../npm-shrinkwrap.json", import.meta.url))) {
    problems.push("npm-shrinkwrap.json was left in the working tree after packing");
  }
  const source = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"));
  if (!("build" in source)) problems.push("paseo-plugin.json lost its build step after packing");
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(
    `${filename}: ${paths.length} files, manifest ok, ${locked.length} locked dependencies`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
