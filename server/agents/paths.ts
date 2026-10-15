export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** True when `child` is `parent` or below it. Works for POSIX and Windows paths on any host. */
export function isWithin(child: string, parent: string): boolean {
  const c = normalizeRemotePath(child);
  const p = normalizeRemotePath(parent);
  if (c === p) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(prefix);
}

/**
 * Normalizes a path on another host without touching the local filesystem: resolves `.` and
 * `..`, collapses separators and lowercases Windows paths. Symlinks cannot be resolved remotely,
 * so allowedPaths is a guardrail for agents, not a sandbox.
 */
export function normalizeRemotePath(value: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\");
  const unified = value.replace(/\\/g, "/");
  const root = /^[a-zA-Z]:\//.test(unified)
    ? unified.slice(0, 3)
    : unified.startsWith("/")
      ? "/"
      : "";
  const parts: string[] = [];
  for (const part of unified.slice(root.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const out = `${root}${parts.join("/")}` || root;
  return windows ? out.toLowerCase() : out;
}
