import { describe, expect, it } from "vitest";
import { condenseItem, isAbsolutePath, isWithin, normalizeRemotePath, truncate } from "./tools";

describe("normalizeRemotePath", () => {
  it("resolves dot segments and duplicate separators", () => {
    expect(normalizeRemotePath("/srv//work/./a/../b/")).toBe("/srv/work/b");
    expect(normalizeRemotePath("/srv/../../etc")).toBe("/etc");
    expect(normalizeRemotePath("/")).toBe("/");
  });

  it("handles Windows paths case-insensitively", () => {
    expect(normalizeRemotePath("C:\\Users\\Me\\..\\Work")).toBe("c:/users/work");
  });
});

describe("isWithin", () => {
  it("matches the directory itself and its descendants only", () => {
    expect(isWithin("/srv/work", "/srv/work")).toBe(true);
    expect(isWithin("/srv/work/app", "/srv/work/")).toBe(true);
    expect(isWithin("/srv/work-other", "/srv/work")).toBe(false);
    expect(isWithin("/srv", "/srv/work")).toBe(false);
  });

  it("cannot be escaped with dot-dot segments", () => {
    expect(isWithin("/srv/work/../../etc", "/srv/work")).toBe(false);
    expect(isWithin("/srv/work/a/../b", "/srv/work")).toBe(true);
  });

  it("compares Windows paths regardless of case and separator", () => {
    expect(isWithin("c:\\Work\\App", "C:/work")).toBe(true);
    expect(isWithin("D:\\work", "C:\\work")).toBe(false);
  });
});

describe("isAbsolutePath", () => {
  it("accepts POSIX, drive and UNC paths only", () => {
    expect(isAbsolutePath("/srv")).toBe(true);
    expect(isAbsolutePath("C:\\srv")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("srv/work")).toBe(false);
    expect(isAbsolutePath("~/work")).toBe(false);
  });
});

describe("condenseItem", () => {
  const options = { includeReasoning: false, maxChars: 10 };

  it("truncates message text and drops reasoning unless asked", () => {
    expect(condenseItem({ type: "assistant_message", text: "0123456789abc" }, options)).toEqual({
      type: "assistant_message",
      text: "0123456789… [3 more chars]",
    });
    expect(condenseItem({ type: "reasoning", text: "hmm" }, options)).toBeNull();
    expect(
      condenseItem({ type: "reasoning", text: "hmm" }, { ...options, includeReasoning: true }),
    ).toEqual({ type: "reasoning", text: "hmm" });
  });

  it("keeps tool call names and status", () => {
    const item = {
      type: "tool_call",
      callId: "c1",
      name: "Bash",
      status: "failed",
      error: "exit 1",
      detail: { type: "unknown", input: null, output: null },
    } as unknown as Parameters<typeof condenseItem>[0];
    expect(condenseItem(item, options)).toEqual({
      type: "tool_call",
      name: "Bash",
      status: "failed",
      error: "exit 1",
    });
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 10)).toBe("short");
  });
});
