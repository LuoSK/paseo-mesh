#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for the GitHub release body.
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: release-notes.mjs <version>");
  process.exit(2);
}
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const heading = new RegExp(`^## \\[?${version.replace(/[.]/g, "\\.")}\\]?(\\s|$)`, "m");
const start = changelog.search(heading);
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.slice(1).search(/^## /m);
const section = next === -1 ? rest : rest.slice(0, next + 1);
process.stdout.write(`${section.split("\n").slice(1).join("\n").trim()}\n`);
