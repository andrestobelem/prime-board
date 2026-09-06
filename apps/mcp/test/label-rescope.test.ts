import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpSession } from "../src/api.ts";
import { createMcpHttpHandler } from "../src/http.ts";
import { createServer as createToolServer } from "../src/server.ts";

const SESSION: McpSession = Object.freeze({
  url: "http://labels-rescope.test",
  apiKey: "pb_labels_rescope",
  workspaceId: "workspace-1",
  context: Object.freeze({
    workspaceId: "workspace-1",
    workspaceName: "Board",
    workspaceUrlKey: "board",
    actorId: "actor-1",
    actorName: "agent",
    actorType: "AGENT",
  }),
});

const SCOPED_TYPES = ["Actor", "ApiKey", "ActorInvitation", "Team", "Label", "Webhook"];
const MODERN_SCHEMA = {
  __schema: {
    queryType: { fields: [{ name: "workspaces" }] },
    types: SCOPED_TYPES.map((name) => ({ name, fields: [{ name: "workspaceId" }] })),
  },
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolPayload(result: unknown): Record<string, unknown> {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  const text = isRecord(first) && typeof first.text === "string" ? first.text : "null";
  const payload: unknown = JSON.parse(text);
  if (!isRecord(payload)) throw new Error("MCP tool did not return an object");
  return payload;
}

describe("MCP Label rescope", () => {
  it("sends Team IDs and null when moving a label between Team and Workspace", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fakeFetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const endpoint = _input instanceof Request ? _input.url : String(_input);
        if (!endpoint.startsWith(SESSION.url)) return originalFetch(_input, init);
        const parsed: unknown = JSON.parse(String(init?.body));
        if (!isRecord(parsed) || typeof parsed.query !== "string") {
          throw new Error("Malformed GraphQL request");
        }
        const variables = isRecord(parsed.variables) ? parsed.variables : {};
        const body = { query: parsed.query, variables };
        requests.push(body);
        if (body.query.includes("__schema")) return jsonResponse({ data: MODERN_SCHEMA });
        if (body.query.includes("team(id:") || body.query.includes("team(key:")) {
          const teamId = variables.id ?? variables.key;
          return jsonResponse({
            data: {
              team: {
                id: teamId,
                key: "PB",
                name: "Prime Board",
                visibility: "PUBLIC",
                accessPolicy: "WORKSPACE_MEMBERS",
                archivedAt: null,
                states: [],
              },
            },
          });
        }
        if (body.query.includes("labelUpdate")) {
          const id = variables.id;
          if (id === "foreign-label") {
            return jsonResponse({
              errors: [{ message: "Label resource not found", extensions: { code: "NOT_FOUND" } }],
            });
          }
          if (id === "merged-label") {
            return jsonResponse({
              errors: [
                {
                  message: "Merged labels cannot be updated",
                  extensions: { code: "VALIDATION_FAILED" },
                },
              ],
            });
          }
          const input = variables.input;
          if (!isRecord(input)) throw new Error("Missing label update input");
          const teamId = input.teamId;
          if (teamId !== undefined && teamId !== null && typeof teamId !== "string") {
            throw new Error("Invalid label team ID");
          }
          return jsonResponse({
            data: {
              labelUpdate: {
                label: { id, name: "label", color: "#000000", teamId: teamId ?? null },
              },
            },
          });
        }
        throw new Error(`Unexpected GraphQL query: ${body.query}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = fakeFetch;

    const handler = createMcpHttpHandler(
      { url: SESSION.url },
      {
        createSession: async ({ apiKey }) => {
          if (apiKey !== SESSION.apiKey) throw new Error("invalid key");
          return SESSION;
        },
        createServer: createToolServer,
      },
    );
    const httpServer = Bun.serve({ port: 0, fetch: handler.fetch });
    const client = new Client({ name: "label-rescope-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${httpServer.url}mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SESSION.apiKey}` } },
    });

    try {
      await client.connect(transport);
      const movedToTeam = await client.callTool({
        name: "save_issue_label",
        arguments: { id: "label-1", name: "renamed", team: "team-1" },
      });
      expect(toolPayload(movedToTeam)).toMatchObject({ id: "label-1", teamId: "team-1" });

      const movedToWorkspace = await client.callTool({
        name: "save_issue_label",
        arguments: { id: "label-1", team: null },
      });
      expect(toolPayload(movedToWorkspace)).toMatchObject({ id: "label-1", teamId: null });

      const mutations = requests.filter((request) => request.query.includes("labelUpdate"));
      expect(mutations.map((request) => request.variables.input)).toEqual([
        { name: "renamed", teamId: "team-1" },
        { teamId: null },
      ]);

      const foreign = await client.callTool({
        name: "save_issue_label",
        arguments: { id: "foreign-label", team: "foreign-team" },
      });
      expect(foreign.isError).toBe(true);
      expect(JSON.stringify(foreign)).toContain("NOT_FOUND");

      const merged = await client.callTool({
        name: "save_issue_label",
        arguments: { id: "merged-label", team: null },
      });
      expect(merged.isError).toBe(true);
      expect(JSON.stringify(merged)).toContain("VALIDATION_FAILED");
    } finally {
      await client.close();
      httpServer.stop(true);
      await handler.close();
      globalThis.fetch = originalFetch;
    }
  });
});
