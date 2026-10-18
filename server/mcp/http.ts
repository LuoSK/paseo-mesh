import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A minimal MCP server over Streamable HTTP. Every POST is answered with a single JSON body;
// the server never opens an SSE stream, which the transport allows. Agents reach it through
// the mcpServers entry the plugin injects, so it only has to cover the tool surface.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpCaller {
  /** Opaque caller nonce from the MCP URL; the plugin maps it to the calling agent. */
  nonce: string | null;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call(args: unknown, context: { caller: McpCaller; signal: AbortSignal }): Promise<McpToolResult>;
}

export interface McpHttpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  token: string;
  tools(): readonly McpTool[];
  onError?(error: unknown): void;
}

export interface McpHttpServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

export async function startMcpHttpServer(
  options: McpHttpServerOptions,
  listen: { host: string; port: number },
): Promise<McpHttpServer> {
  const sockets = new Set<import("node:net").Socket>();
  const requests = new Map<string, AbortController>();
  const server: Server = createServer((req, res) => {
    void handleHttp(options, req, res, requests).catch((error: unknown) => {
      options.onError?.(error);
      if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, "Internal error"));
      else res.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://${listen.host}:${port}/mcp`,
    async close() {
      for (const request of requests.values()) request.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

async function handleHttp(
  options: McpHttpServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
  requests: Map<string, AbortController>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  if (!isAuthorized(req.headers.authorization, options.token)) {
    sendJson(res, 401, rpcError(null, -32001, "Unauthorized"));
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    // No server-initiated stream and no server-side session state to delete.
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, "Parse error"));
    return;
  }

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const caller: McpCaller = { nonce: url.searchParams.get("caller") || null };
  const messages = Array.isArray(body) ? body : [body];
  const responses: JsonRpcResponse[] = [];
  for (const message of messages) {
    if (
      isRequest(message) &&
      message.method === "notifications/cancelled" &&
      isObject(message.params)
    ) {
      requests.get(requestKey(caller, message.params.requestId))?.abort();
      continue;
    }
    const key = isRequest(message) ? requestKey(caller, message.id) : "";
    if (isRequest(message) && message.method === "tools/call") requests.set(key, abort);
    let response: JsonRpcResponse | null;
    try {
      response = await handleMessage(options, message, caller, abort.signal);
    } finally {
      if (requests.get(key) === abort) requests.delete(key);
    }
    if (response) responses.push(response);
  }
  if (responses.length === 0) {
    res.writeHead(202).end();
    return;
  }
  sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
}

function requestKey(caller: McpCaller, id: unknown): string {
  return JSON.stringify([caller.nonce, typeof id, id]);
}

async function handleMessage(
  options: McpHttpServerOptions,
  message: unknown,
  caller: McpCaller,
  signal: AbortSignal,
): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    // Responses to server requests and malformed notifications have nothing to answer.
    if (isObject(message) && "id" in message && !("method" in message)) return null;
    return rpcError(null, -32600, "Invalid Request");
  }
  if (message.id === undefined) return null;
  const id = message.id;
  switch (message.method) {
    case "initialize": {
      const requested = isObject(message.params) ? message.params.protocolVersion : undefined;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: options.tools().map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        },
      };
    case "tools/call": {
      const params = isObject(message.params) ? message.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const tool = options.tools().find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.call(params.arguments ?? {}, { caller, signal });
        return { jsonrpc: "2.0", id, result };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: errorMessage(error) }],
            isError: true,
          } satisfies McpToolResult,
        };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
