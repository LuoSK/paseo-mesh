import { describe, expect, it } from "vitest";
import { describeFailure } from "./peer-connection";

describe("describeFailure", () => {
  it("does not repeat the client's last error", () => {
    expect(describeFailure("Transport closed (code 1006)", "Transport closed (code 1006)")).toBe(
      "Transport closed (code 1006)",
    );
    expect(describeFailure("Connect failed", "Connect failed: ECONNREFUSED")).toBe(
      "Connect failed: ECONNREFUSED",
    );
    expect(describeFailure("Timed out", "Invalid password")).toBe("Timed out (Invalid password)");
    expect(describeFailure("Timed out", null)).toBe("Timed out");
  });
});
