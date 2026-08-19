import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpApiError, type McpSession } from "../src/api.ts";
import { createServer as createToolServer } from "../src/server.ts";
import { createMcpHttpHandler, loadMcpHttpConfig } from "../src/http.ts";

const SESSION: McpSession = Object.freeze({
  url: "http://board.invalid",
  apiKey: "pb_test",
  context: Object.freeze({
    workspaceId: "workspace-1",
    workspaceName: "Board",
    workspaceUrlKey: "board",
    actorId: "actor-1",
    actorName: "agent",
    actorType: "AGENT",
  }),
});

let handler: ReturnType<typeof createMcpHttpHandler>;
let httpServer: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  handler = createMcpHttpHandler(
    { url: SESSION.url },
    {
      createSession: async ({ apiKey }) => {
        if (apiKey !== SESSION.apiKey) throw new McpApiError("UNAUTHORIZED", "invalid key");
        return SESSION;
      },
      createServer: () => {
        const server = new McpServer({ name: "http-test", version: "0.0.1" });
        server.registerTool(
          "echo",
          { description: "Echo a message", inputSchema: { message: z.string() } },
          async ({ message }) => ({ content: [{ type: "text", text: message }] }),
        );
        return server;
      },
    },
  );
  httpServer = Bun.serve({ port: 0, fetch: handler.fetch });
});

afterEach(async () => {
  httpServer.stop(true);
  await handler.close();
});

describe("MCP Streamable HTTP auth and protocol", () => {
  it("rejects missing and malformed Bearer credentials before MCP protocol handling", async () => {
    const url = `${httpServer.url}mcp`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const missing = await fetch(url, { method: "POST", body });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const malformed = await fetch(url, {
      method: "POST",
      headers: { authorization: "Basic abc", "content-type": "application/json" },
      body,
    });
    expect(malformed.status).toBe(401);

    const invalid = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer pb_invalid",
        "content-type": "application/json",
      },
      body,
    });
    expect(invalid.status).toBe(401);
    expect((await invalid.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns a stateful MCP session and binds subsequent requests to its key", async () => {
    const url = `${httpServer.url}mcp`;
    const initialize = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SESSION.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw-test", version: "0.0.1" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("content-type")).toContain("text/event-stream");
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initialize.text();

    const hijack = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer pb_other",
        "content-type": "application/json",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(hijack.status).toBe(401);
  });

  it("revalidates an existing session before dispatch after key revocation", async () => {
    let revoked = false;
    const revalidationHandler = createMcpHttpHandler(
      { url: SESSION.url },
      {
        createSession: async ({ apiKey }) => {
          if (apiKey !== SESSION.apiKey || revoked)
            throw new McpApiError("UNAUTHORIZED", "revoked key");
          return SESSION;
        },
        createServer: () => {
          const server = new McpServer({ name: "revalidation-test", version: "0.0.1" });
          server.registerTool(
            "echo",
            { description: "Echo a message", inputSchema: { message: z.string() } },
            async ({ message }) => ({ content: [{ type: "text", text: message }] }),
          );
          return server;
        },
      },
    );
    const revalidationServer = Bun.serve({ port: 0, fetch: revalidationHandler.fetch });
    const url = `${revalidationServer.url}mcp`;
    const headers = {
      authorization: `Bearer ${SESSION.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    try {
      const initialize = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "revalidation-test", version: "0.0.1" },
          },
        }),
      });
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(initialize.status).toBe(200);
      expect(sessionId).toBeTruthy();
      await initialize.text();

      const initialized = await fetch(url, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sessionId! },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect([200, 202]).toContain(initialized.status);
      revoked = true;

      const listed = await fetch(url, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sessionId! },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(listed.status).toBe(401);
      expect((await listed.json()).error.code).toBe("UNAUTHORIZED");
    } finally {
      revalidationServer.stop(true);
      await revalidationHandler.close();
    }
  });

  it("supports initialize, tools/list and tools/call through the official client transport", async () => {
    const client = new Client({ name: "http-client-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${httpServer.url}mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SESSION.apiKey}` } },
    });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { message: "hello" } });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    await client.close();
  });

  it("keeps concurrent MCP sessions isolated by credential and context", async () => {
    const otherSession: McpSession = Object.freeze({
      ...SESSION,
      apiKey: "pb_other",
      context: Object.freeze({ ...SESSION.context, actorId: "actor-2", actorName: "other-agent" }),
    });
    const sessions = new Map([
      [SESSION.apiKey, SESSION],
      [otherSession.apiKey, otherSession],
    ]);
    const isolatedHandler = createMcpHttpHandler(
      { url: SESSION.url },
      {
        createSession: async ({ apiKey }) => {
          const session = sessions.get(apiKey);
          if (!session) throw new McpApiError("UNAUTHORIZED", "invalid key");
          return session;
        },
        createServer: (session) => {
          const server = new McpServer({ name: "isolated-test", version: "0.0.1" });
          server.registerTool(
            "identity",
            { description: "Report the bound credential", inputSchema: {} },
            async () => ({ content: [{ type: "text", text: session.apiKey }] }),
          );
          return server;
        },
      },
    );
    const isolatedServer = Bun.serve({ port: 0, fetch: isolatedHandler.fetch });
    const first = new Client({ name: "first-client", version: "0.0.1" });
    const second = new Client({ name: "second-client", version: "0.0.1" });
    const firstTransport = new StreamableHTTPClientTransport(new URL(`${isolatedServer.url}mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SESSION.apiKey}` } },
    });
    const secondTransport = new StreamableHTTPClientTransport(new URL(`${isolatedServer.url}mcp`), {
      requestInit: { headers: { authorization: `Bearer ${otherSession.apiKey}` } },
    });

    try {
      await Promise.all([first.connect(firstTransport), second.connect(secondTransport)]);
      expect(firstTransport.sessionId).toBeTruthy();
      expect(secondTransport.sessionId).toBeTruthy();
      expect(firstTransport.sessionId).not.toBe(secondTransport.sessionId);
      const [firstResult, secondResult] = await Promise.all([
        first.callTool({ name: "identity", arguments: {} }),
        second.callTool({ name: "identity", arguments: {} }),
      ]);
      expect(firstResult.content).toEqual([{ type: "text", text: SESSION.apiKey }]);
      expect(secondResult.content).toEqual([{ type: "text", text: otherSession.apiKey }]);
    } finally {
      await Promise.all([first.close(), second.close()]);
      isolatedServer.stop(true);
      await isolatedHandler.close();
    }
  });

  it("routes calls to the existing GraphQL-backed MCP handlers", async () => {
    const originalFetch = globalThis.fetch;
    const actualHandler = createMcpHttpHandler(
      { url: SESSION.url },
      {
        createSession: async () => SESSION,
        createServer: createToolServer,
      },
    );
    const actualHttpServer = Bun.serve({ port: 0, fetch: actualHandler.fetch });
    globalThis.fetch = (async (input, init) => {
      if (
        new URL(input instanceof Request ? input.url : input.toString()).hostname ===
        "board.invalid"
      ) {
        return new Response(
          JSON.stringify({
            data: {
              workspace: { id: "workspace-1", name: "Board", urlKey: "board" },
              viewer: { id: "actor-1", name: "agent", type: "AGENT" },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const client = new Client({ name: "existing-handler-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${actualHttpServer.url}mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SESSION.apiKey}` } },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["list_issues", "save_issue", "save_comment", "get_workspace"]),
      );
      const result = await client.callTool({ name: "get_workspace", arguments: {} });
      const content = result.content as Array<{ text?: string }>;
      expect(JSON.parse(content[0]?.text ?? "")).toEqual({
        workspace: { id: "workspace-1", name: "Board", urlKey: "board" },
        viewer: { id: "actor-1", name: "agent", type: "AGENT" },
      });
    } finally {
      await client.close();
      actualHttpServer.stop(true);
      await actualHandler.close();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("MCP HTTP config", () => {
  it("defaults to a loopback endpoint and does not require a process-wide key", () => {
    expect(loadMcpHttpConfig({})).toMatchObject({
      url: "http://localhost:3333",
      hostname: "127.0.0.1",
      port: 3334,
      path: "/mcp",
    });
  });

  it("validates the configured port and path", () => {
    expect(() => loadMcpHttpConfig({ PRIME_BOARD_MCP_PORT: "nope" })).toThrow(
      "PRIME_BOARD_MCP_PORT",
    );
    expect(() => loadMcpHttpConfig({ PRIME_BOARD_MCP_PATH: "mcp" })).toThrow(
      "PRIME_BOARD_MCP_PATH",
    );
    expect(() => loadMcpHttpConfig({ PRIME_BOARD_MCP_HOST: "0.0.0.0" })).toThrow(
      "PRIME_BOARD_MCP_HOST",
    );
  });
});
