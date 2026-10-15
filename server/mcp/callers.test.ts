import { describe, expect, it } from "vitest";
import { injectionConfigSchema, injectionPatchSchema } from "../../shared/config";
import { pruned } from "./callers";

describe("pruned", () => {
  const now = Date.parse("2026-10-15T00:00:00.000Z");
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

  it("drops unbound nonces older than a day and keeps bound ones", () => {
    const result = pruned(
      {
        old: { agentId: null, createdAt: at(30) },
        recent: { agentId: null, createdAt: at(1) },
        bound: { agentId: "a1", createdAt: at(400) },
      },
      now,
    );
    expect(Object.keys(result).sort()).toEqual(["bound", "recent"]);
  });

  it("keeps the newest entries when over the limit, leaving room for one more", () => {
    const callers = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `n${index}`,
        { agentId: `a${index}`, createdAt: at(5 - index) },
      ]),
    );
    expect(Object.keys(pruned(callers, now, 3)).sort()).toEqual(["n3", "n4"]);
  });
});

describe("injection settings patch", () => {
  it("does not fill in defaults for fields that were not sent", () => {
    expect(injectionPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(injectionConfigSchema.partial().parse({ enabled: false })).not.toEqual({
      enabled: false,
    });
  });
});
