import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderMcpServerConfig,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";

// Deterministic provider for end-to-end tests. Every prompt is a small command:
//   <text>                         reply "Echo: <text>"
//   SLEEP <ms> <text>              run for <ms>, then reply "Echo: <text>"
//   FAIL <message>                 fail the turn
//   ENV <name>                     reply with the session env value
//   MCP <server> <tool> <json>     call an injected HTTP MCP tool, reply with its text

const CAPABILITIES = [
  "prompt.message",
  "session.archive",
  "session.list",
  "session.persistence",
  "session.unarchive",
] as const;

interface EchoSession {
  config: ProviderSessionConfig;
  persistence: ProviderPersistence;
  turn: number;
  active: { turnId: string; cancel(): void } | null;
}

interface State {
  sessions: Map<string, EchoSession>;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
}

export function createEchoProvider(): ProviderRegistration {
  return {
    id: "mesh-echo",
    label: "Mesh echo (test)",
    description: "Deterministic provider for paseo-mesh end-to-end tests",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

function createConnection(capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  const state: State = {
    sessions: new Map(),
    capabilities,
    emit(event) {
      if (closed) return;
      for (const listener of listeners) listener(event);
    },
  };
  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      if (input.type === "session.open") {
        if (state.sessions.has(input.sessionId)) throw new Error("Session already exists");
      } else if ("sessionId" in input && !state.sessions.has(input.sessionId)) {
        throw new Error(`Unknown session: ${input.sessionId}`);
      }
      requireProviderCapabilities(state.capabilities, input);
      queueMicrotask(() => {
        if (!closed) void dispatch(input, state);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      for (const session of state.sessions.values()) session.active?.cancel();
      state.sessions.clear();
      listeners.clear();
    },
  };
}

async function dispatch(input: ProviderInput, state: State): Promise<void> {
  switch (input.type) {
    case "catalog":
      state.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: {
          models: [{ id: "echo-1", label: "Echo 1" }],
          modes: [{ id: "default", label: "Default" }],
          defaultModel: "echo-1",
          defaultMode: "default",
        },
      });
      return;
    case "sessions":
      state.emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: [...state.sessions.values()].map((session) => ({
          persistence: session.persistence,
          cwd: session.config.cwd,
          title: session.config.title,
        })),
      });
      return;
    case "session.open": {
      const persistence = input.persistence ?? {
        version: 1,
        data: { nativeSessionId: `echo:${input.sessionId}` },
      };
      state.sessions.set(input.sessionId, {
        config: input.config,
        persistence,
        turn: 0,
        active: null,
      });
      state.emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities: state.capabilities,
        restoration: "core",
        persistence,
        title: input.config.title,
        cwd: input.config.cwd,
      });
      state.emit({
        type: "session.config",
        sessionId: input.sessionId,
        config: {
          model: "echo-1",
          mode: "default",
          models: [{ id: "echo-1", label: "Echo 1" }],
          modes: [{ id: "default", label: "Default" }],
          thinkingOptions: [],
          settings: [],
        },
      });
      state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      return;
    }
    case "session.prompt":
      await prompt(input, state);
      return;
    case "session.interrupt": {
      state.sessions.get(input.sessionId)?.active?.cancel();
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.close":
      state.sessions.get(input.sessionId)?.active?.cancel();
      state.sessions.delete(input.sessionId);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.archive":
    case "session.unarchive":
    case "session.configure":
    case "session.permission":
    case "session.revert":
      if ("requestId" in input)
        state.emit({ type: "request.completed", requestId: input.requestId });
      return;
  }
}

async function prompt(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: State,
): Promise<void> {
  const session = state.sessions.get(input.sessionId);
  if (!session) return;
  if (input.prompt.input.type !== "message") {
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "Commands are not supported" } },
    });
    return;
  }
  session.active?.cancel();
  session.turn += 1;
  const turnId = `turn-${session.turn}`;
  const text = input.prompt.input.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  let canceled = false;
  let wake: () => void = () => {};
  session.active = {
    turnId,
    cancel() {
      canceled = true;
      wake();
    },
  };
  state.emit({
    type: "timeline.item",
    sessionId: input.sessionId,
    item: {
      type: "user_message",
      id: `user-${session.turn}`,
      text,
      clientMessageId: input.prompt.clientMessageId,
    },
  });
  state.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "turn", turnId },
  });
  state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });

  const finish = (outcome: { reply: string } | { error: string }) => {
    if (session.active?.turnId === turnId) session.active = null;
    if (canceled) {
      state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "canceled" });
      return;
    }
    if ("error" in outcome) {
      state.emit({
        type: "session.turn",
        sessionId: input.sessionId,
        turnId,
        state: "failed",
        error: { message: outcome.error },
      });
      return;
    }
    state.emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: { type: "assistant_message", id: `assistant-${session.turn}`, text: outcome.reply },
    });
    session.persistence = {
      version: 1,
      data: { nativeSessionId: `echo:${input.sessionId}`, turns: session.turn },
    };
    state.emit({
      type: "session.persistence",
      sessionId: input.sessionId,
      persistence: session.persistence,
    });
    state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
  };

  const [command = "", ...rest] = text.trim().split(/\s+/);
  try {
    switch (command.toUpperCase()) {
      case "SLEEP": {
        const ms = Number(rest[0]);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Number.isFinite(ms) ? ms : 0);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        finish({ reply: `Echo: ${rest.slice(1).join(" ")}` });
        return;
      }
      case "FAIL":
        finish({ error: rest.join(" ") || "Requested failure" });
        return;
      case "ENV":
        finish({ reply: `ENV ${rest[0]}=${session.config.env[rest[0] ?? ""] ?? "<unset>"}` });
        return;
      case "MCP": {
        const [server = "", tool = "", ...json] = rest;
        const config = session.config.mcpServers[server];
        if (!config) {
          finish({ reply: `MCP error: server ${server} is not configured` });
          return;
        }
        const args = json.length ? JSON.parse(json.join(" ")) : {};
        finish({ reply: await callMcpTool(config, tool, args) });
        return;
      }
      default:
        finish({ reply: `Echo: ${text}` });
    }
  } catch (error) {
    finish({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function callMcpTool(
  config: ProviderMcpServerConfig,
  tool: string,
  args: unknown,
): Promise<string> {
  if (config.type === "stdio") return "MCP error: stdio servers are not supported by mesh-echo";
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...config.headers,
  };
  const rpc = async (body: unknown) => {
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 202) return null;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    return (await response.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message: string };
    };
  };
  await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mesh-echo", version: "1" },
    },
  });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  if (!result) throw new Error("MCP returned no response");
  if (result.error) return `MCP error: ${result.error.message}`;
  const text = (result.result?.content ?? []).map((part) => part.text ?? "").join("\n");
  return `${result.result?.isError ? "MCP tool error" : "MCP result"}: ${text}`;
}
