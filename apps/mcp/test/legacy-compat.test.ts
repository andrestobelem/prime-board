import { afterEach, describe, expect, it } from "bun:test";
import { createMcpSession, gqlRequest } from "../src/api.ts";
import { LEGACY_SCHEMA_INTROSPECTION } from "../../web/test/fixtures/legacy-schema-introspection.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MCP legacy Workspace compatibility", () => {
  it("removes unsupported scoped fields after the 4295813 SDL probe", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      requests.push(query);
      if (query.includes("__schema")) {
        return new Response(JSON.stringify({ data: LEGACY_SCHEMA_INTROSPECTION }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { viewer: { id: "actor" } } }), { status: 200 });
    }) as unknown as typeof fetch;

    await gqlRequest(
      { url: "http://legacy.test", apiKey: "legacy-key" },
      "{ viewer { id workspaceId name } team { id workspaceId key } }",
    );

    expect(requests[1]).not.toContain("workspaceId");
  });

  it("resolves the effective Workspace without a viewer.workspaceId field", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      requests.push(query);
      if (query.includes("__schema")) {
        return new Response(JSON.stringify({ data: LEGACY_SCHEMA_INTROSPECTION }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            viewer: { id: "actor", name: "Admin", type: "HUMAN" },
            workspace: { id: "workspace", name: "Workspace", urlKey: "workspace" },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const session = await createMcpSession({
      url: "http://legacy-session.test",
      apiKey: "legacy-key-2",
    });

    expect(session.context.workspaceId).toBe("workspace");
    expect(requests[1]).not.toContain("workspaceId");
  });
});
