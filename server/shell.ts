import { createHash, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { PaseoTerminalHandle } from "@getpaseo/client";
import { messageOf } from "./errors";
import { type HostRef, type HostRegistry, hostLabel } from "./hosts/host-registry";
import type { TerminalDaemon } from "./hosts/peer";
import type { Logger } from "./logger";

export interface ShellInput {
  cwd: string;
  script: string;
  shell: string;
  timeoutSeconds: number;
  maxOutputChars: number;
}

export interface ShellResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  error: string | null;
  cleanupPending: boolean;
}

type Directory = Pick<HostRegistry, "api" | "terminalSession">;

/** Streams raw PTY bytes, keeping framing separate from the bounded script output. */
export class ShellOutput {
  private pending = "";
  private started = false;
  private finished = false;
  private readonly decoder = new StringDecoder("utf8");
  readonly start: string;
  private readonly end: string;
  output = "";
  exitCode: number | null = null;
  truncated = false;

  constructor(
    token: string,
    private readonly limit: number,
  ) {
    this.start = `\x1eMESH_${token}_START\x1f`;
    this.end = `\x1eMESH_${token}_EXIT:`;
  }

  feed(bytes: Uint8Array): void {
    if (this.finished) return;
    this.pending += this.decoder.write(Buffer.from(bytes));
    if (!this.started) {
      const index = this.pending.indexOf(this.start);
      if (index === -1) {
        this.pending = this.pending.slice(-this.start.length);
        return;
      }
      this.started = true;
      this.pending = this.pending.slice(index + this.start.length);
    }
    const index = this.pending.indexOf(this.end);
    if (index !== -1) {
      this.append(this.pending.slice(0, index));
      this.pending = this.pending.slice(index);
      const boundary = this.pending.indexOf("\x1f", this.end.length);
      const status = this.pending.slice(this.end.length, boundary);
      if (boundary !== -1 && /^[0-9]{1,3}$/.test(status)) {
        this.exitCode = Number(status);
        this.finished = true;
        this.pending = "";
      }
      return;
    }
    const keep = this.end.length - 1;
    if (this.pending.length > keep) {
      this.append(this.pending.slice(0, -keep));
      this.pending = this.pending.slice(-keep);
    }
  }

  flush(): void {
    if (this.started && !this.finished) this.append(this.pending + this.decoder.end());
    this.pending = "";
  }

  private append(text: string): void {
    const remaining = this.limit - this.output.length;
    if (text.length > remaining) this.truncated = true;
    this.output += text.slice(0, remaining);
  }
}

/**
 * A read gate prevents short scripts from finishing before observation attaches. The PTY's
 * process group owns the script and watchdog; exiting the wrapper terminates that group.
 * Result acknowledgement keeps the terminal alive until its final output is collected.
 * The watchdog also bounds terminals whose create response or owning plugin was lost.
 */
export function shellWrapper(): string {
  return `stty -echo -opost || exit 125
trap 'kill -KILL 0' EXIT
trap 'exit 125' HUP INT TERM
(sleep "$3"; kill -KILL 0) &
IFS= read -r mesh_start || exit 125
[ "$mesh_start" = "$4" ] || exit 125
printf '\\036MESH_%s_START\\037' "$4"
"$1" -c "$2" </dev/null
mesh_status=$?
printf '\\036MESH_%s_EXIT:%s\\037' "$4" "$mesh_status"
IFS= read -r mesh_done || :
exit "$mesh_status"`;
}

export class ShellRunner {
  readonly terminalPrefix: string;
  private closed = false;
  private readonly active = new Map<
    string,
    { controller: AbortController; task: Promise<ShellResult> }
  >();

  constructor(
    private readonly directory: Directory,
    owner: string,
    private readonly logger: Logger,
  ) {
    this.terminalPrefix = `paseo-mesh-exec-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}-`;
  }

  execute(host: HostRef, input: ShellInput, signal: AbortSignal): Promise<ShellResult> {
    if (this.closed) throw new Error("paseo-mesh is stopping");
    signal.throwIfAborted();
    const name = `${this.terminalPrefix}${randomBytes(16).toString("hex")}`;
    const controller = new AbortController();
    const task = this.run(host, input, name, controller, signal).finally(() => {
      this.active.delete(name);
    });
    this.active.set(name, { controller, task });
    return task;
  }

  /** Reap only this installation's abandoned terminals, preserving its active executions. */
  async recover(host: HostRef): Promise<void> {
    try {
      const api = await this.directory.api(host, 3_000);
      const { entries } = await api.terminals.list();
      await Promise.all(
        entries
          .filter(
            (terminal) =>
              terminal.name.startsWith(this.terminalPrefix) && !this.active.has(terminal.name),
          )
          .map((terminal) => api.terminals.ref(terminal).kill()),
      );
    } catch (error) {
      this.logger.warn(`Shell cleanup on ${hostLabel(host)} deferred: ${messageOf(error)}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort(new Error("paseo-mesh is stopping"));
    await Promise.allSettled(runs.map((run) => run.task));
  }

  private async run(
    host: HostRef,
    input: ShellInput,
    name: string,
    controller: AbortController,
    callerSignal: AbortSignal,
  ): Promise<ShellResult> {
    const token = name.slice(this.terminalPrefix.length);
    const output = new ShellOutput(token, input.maxOutputChars);
    const result: ShellResult = {
      output: "",
      exitCode: null,
      timedOut: false,
      truncated: false,
      error: null,
      cleanupPending: false,
    };
    const cancel = () => controller.abort(new Error("Shell execution cancelled"));
    callerSignal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      result.timedOut = true;
      controller.abort(
        new Error(`Shell execution timed out after ${input.timeoutSeconds} seconds`),
      );
    }, input.timeoutSeconds * 1_000);
    const { signal } = controller;
    let terminal: PaseoTerminalHandle | undefined;
    let observation: ReturnType<TerminalDaemon["observeTerminal"]> | undefined;
    let unsubscribe: (() => void) | undefined;
    let live = true;
    let createPending = false;
    try {
      const { api, daemon } = await abortable(this.directory.terminalSession(host, 10_000), signal);
      unsubscribe = daemon.subscribeConnectionStatus((state) => {
        if (state.status !== "connected")
          controller.abort(
            new Error("Host disconnected during shell execution; the script was not retried"),
          );
      });
      const workspace = await abortable(api.workspaces.open(input.cwd), signal);
      signal.throwIfAborted();
      createPending = true;
      const creating = workspace.terminals.create({
        name,
        command: "/bin/sh",
        args: [
          "-c",
          shellWrapper(),
          "mesh-exec",
          input.shell,
          input.script,
          String(input.timeoutSeconds + 10),
          token,
        ],
      });
      // A timed-out create may still have reached the host. Clean its late response too.
      void creating
        .then(
          async (created) => {
            createPending = false;
            terminal = created;
            if (!live) await created.kill();
          },
          () => {
            createPending = false;
          },
        )
        .catch((error) => this.logger.warn(`Late shell terminal cleanup: ${messageOf(error)}`));
      terminal = await abortable(creating, signal);
      let finish!: () => void;
      let fail!: (error: unknown) => void;
      const ended = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      // Attach a rejection handler before the first await; observation can fail immediately.
      void ended.catch(() => {});
      observation = daemon.observeTerminal(terminal.id, (event) => {
        if (event.type === "output") {
          output.feed(event.data);
          if (output.exitCode !== null) finish();
        }
      });
      observation.subscribe({
        snapshot(snapshot) {
          if (snapshot.error) fail(new Error(snapshot.error));
        },
        update(message) {
          if (message.type === "terminal_stream_exit") {
            if (message.payload.error) fail(new Error(message.payload.error));
            else finish();
          }
        },
        error: fail,
      });
      const ready = await abortable(observation.ready, signal);
      if (ready.error) throw new Error(ready.error);
      signal.throwIfAborted();
      terminal.write(`${token}\n`);
      await abortable(ended, signal);
      if (output.exitCode === null) throw new Error("Shell terminal exited without an exit code");
      terminal.write(`${token}\n`);
    } catch (error) {
      result.error = messageOf(error);
      result.cleanupPending = createPending;
    } finally {
      live = false;
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", cancel);
      unsubscribe?.();
      // Bounded cleanup uses a current connection, including after a peer reconnected.
      if (terminal) {
        try {
          await abortable(
            (async () => {
              const api = await this.directory.api(host, 3_000);
              await api.terminals.ref(terminal.id).kill();
            })(),
            AbortSignal.timeout(5_000),
          );
        } catch (error) {
          result.cleanupPending = true;
          this.logger.warn(`Shell terminal ${terminal.id} cleanup deferred: ${messageOf(error)}`);
        }
      }
      if (observation)
        await abortable(observation.release(), AbortSignal.timeout(1_000)).catch(() => {});
      output.flush();
      result.output = output.output;
      result.exitCode = output.exitCode;
      result.truncated = output.truncated;
    }
    return result;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach to the promise even when already aborted so late rejections stay handled.
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Shell execution cancelled"));
    if (signal.aborted) {
      promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
