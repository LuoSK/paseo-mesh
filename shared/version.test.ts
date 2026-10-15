import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESH_VERSION, PASEO_CLIENT_APP_VERSION } from "./version";

describe("version constants", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  it("match package.json", () => {
    expect(MESH_VERSION).toBe(pkg.version);
  });

  it("track the @getpaseo/client dependency", () => {
    const installed = JSON.parse(
      readFileSync(
        new URL("../node_modules/@getpaseo/client/package.json", import.meta.url),
        "utf8",
      ),
    );
    expect(PASEO_CLIENT_APP_VERSION).toBe(installed.version);
  });
});
