import { randomBytes } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";

/**
 * One JSON document on disk, written atomically with owner-only permissions. Peer passwords
 * and offer keys live here, so the file is never world-readable and never leaves the host.
 */
export class JsonFileStore<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly schema: ZodType<T>,
    private readonly fallback: () => T,
  ) {}

  /** Missing file yields the fallback; a corrupt file throws so callers keep the last good value. */
  async read(): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.fallback();
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path.basename(this.filePath)} is not valid JSON: ${String(error)}`);
    }
    const parsed = this.schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${path.basename(this.filePath)} is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** True when the raw file exists and `predicate` holds for its parsed JSON. */
  async rawMatches(predicate: (raw: unknown) => boolean): Promise<boolean> {
    try {
      return predicate(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      return false;
    }
  }

  /** Serialized read-modify-write so concurrent RPCs cannot lose each other's changes. */
  update(mutate: (current: T) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const current = await this.read();
      const value = this.schema.parse(await mutate(current));
      await this.write(value);
      return value;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async write(value: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.filePath);
  }

  /**
   * Calls `onChange` (debounced) when the file is replaced or edited outside this process.
   * Watches the directory because atomic renames replace the inode a file watcher would hold.
   */
  watch(onChange: () => void, debounceMs = 150): () => void {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher | null = null;
    let closed = false;
    const start = async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (closed) return;
      watcher = watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== base) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, debounceMs);
      });
      watcher.on("error", () => {});
    };
    start().catch(() => {
      // Without a watcher, external edits apply on the next plugin start instead.
    });
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  }
}
