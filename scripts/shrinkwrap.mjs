#!/usr/bin/env node
// Builds npm-shrinkwrap.json for the published package from package-lock.json: the runtime
// dependency closure only, with the exact versions, sources and integrity hashes the repository
// is tested against. npm honours a published shrinkwrap, so npm installs of the plugin get the
// same dependency tree as Git installs (`npm ci --omit=dev`). The Paseo plugin registry requires
// a locked tree for npm artifacts.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

export function buildShrinkwrap(pkg, lock) {
  const packages = lock.packages ?? {};
  const keep = new Map();

  // Node resolution: from `from`, look in from/node_modules/name, then each ancestor's.
  function resolve(from, name) {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const index = base.lastIndexOf("/node_modules/");
      base = index === -1 ? "" : base.slice(0, index);
    }
  }

  function visit(from, deps, { optional }) {
    for (const name of Object.keys(deps ?? {})) {
      const location = resolve(from, name);
      if (!location) {
        if (optional) continue;
        throw new Error(
          `package-lock.json has no entry for ${name} needed by ${from || "the root"}`,
        );
      }
      if (keep.has(location)) continue;
      const entry = packages[location];
      keep.set(location, entry);
      visit(location, entry.dependencies, { optional: false });
      visit(location, entry.optionalDependencies, { optional: true });
      const required = Object.fromEntries(
        Object.entries(entry.peerDependencies ?? {}).filter(
          ([peer]) => !entry.peerDependenciesMeta?.[peer]?.optional,
        ),
      );
      visit(location, required, { optional: false });
    }
  }

  visit("", pkg.dependencies, { optional: false });
  visit("", pkg.optionalDependencies, { optional: true });

  const rootEntry = {
    name: pkg.name,
    version: pkg.version,
    ...(pkg.license ? { license: pkg.license } : {}),
    ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    ...(pkg.bin ? { bin: pkg.bin } : {}),
    ...(pkg.engines ? { engines: pkg.engines } : {}),
  };
  const entries = [...keep.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([location, entry]) => {
      const { dev, devOptional, ...rest } = entry;
      if (!rest.resolved || !rest.integrity) {
        throw new Error(`${location} has no resolved source or integrity in package-lock.json`);
      }
      return [location, rest];
    });
  return {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": rootEntry, ...Object.fromEntries(entries) },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const out = process.argv[2] ?? new URL("npm-shrinkwrap.json", root);
  writeFileSync(out, `${JSON.stringify(buildShrinkwrap(pkg, lock), null, 2)}\n`);
}
