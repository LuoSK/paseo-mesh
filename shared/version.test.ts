import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESH_VERSION, PASEO_CLIENT_APP_VERSION } from "./version";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"));

describe("version constants", () => {
  it("match package.json", () => {
    expect(MESH_VERSION).toBe(pkg.version);
  });

  it("track the declared @getpaseo/client range", () => {
    expect(pkg.dependencies["@getpaseo/client"]).toBe(`^${PASEO_CLIENT_APP_VERSION}`);
  });

  it("declare a minimum Paseo version in the manifest", () => {
    expect(manifest.requirements.paseo).toMatch(/^>=\d+\.\d+\.\d+$/);
  });
});
