import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpHttpServer, type McpTool, startMcpHttpServer } from "./mcp-http";

const TOKEN = "test-token-123";

function echoTool(): McpTool {
  return {
    name: "echo",
    title: "Echo",
    description: "Echoes text and the caller",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async call(args, { caller }) {
      const { text } = args as { text: string };
      return {
        content: [{ type: "text", text: `${text} from ${caller.nonce ?? "anonymous"}` }],
        structuredContent: { text, caller: caller.nonce },
      };
    },
  };
}

function failingTool(): McpTool {
  return {
    name: "fail",
    title: "Fail",
    description: "Always throws",
    inputSchema: { type: "object", properties: {} },
    async call() {
      throw new Error('Host "gpu" is offline');
    },
  };
}

async function connect(url: string, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("startMcpHttpServer", () => {
  let server: McpHttpServer;

  beforeEach(async () => {
    server = await startMcpHttpServer(
      {
        name: "paseo-mesh",
        version: "0.0.0-test",
        instructions: "Use mesh tools",
        token: TOKEN,
        tools: () => [echoTool(), failingTool()],
      },
      { host: "127.0.0.1", port: 0 },
    );
  });

  afterEach(async () => {
    await server.close();
  });

  it("serves tools to the official MCP SDK client", async () => {
    const client = await connect(`${server.url}?caller=agent-1`, TOKEN);
    expect(client.getServerVersion()).toMatchObject({ name: "paseo-mesh" });
    expect(client.getInstructions()).toBe("Use mesh tools");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "hi from agent-1" }]);
    expect(result.structuredContent).toEqual({ text: "hi", caller: "agent-1" });
    await client.close();
  });

  it("reports tool exceptions as tool errors, not protocol errors", async () => {
    const client = await connect(server.url, TOKEN);
    const result = await client.callTool({ name: "fail", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: 'Host "gpu" is offline' }]);
    await client.close();
  });

  it("rejects requests without the bearer token", async () => {
    await expect(connect(server.url, "wrong")).rejects.toThrow();
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
  });

  it("answers JSON-RPC edge cases", async () => {
    const post = (body: string) =>
      fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body,
      });
    expect((await post("{bad")).status).toBe(400);
    const notification = await post(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(202);
    const unknown = await (
      await post(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope" }))
    ).json();
    expect(unknown).toMatchObject({ id: 7, error: { code: -32601 } });
    const batch = await (
      await post(
        JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { jsonrpc: "2.0", method: "notifications/cancelled" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "missing" } },
        ]),
      )
    ).json();
    expect(batch).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Unknown tool: missing" } },
    ]);
    const get = await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
  });

  it("negotiates the requested protocol version when supported", async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      }),
    });
    const body = (await response.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });
});
