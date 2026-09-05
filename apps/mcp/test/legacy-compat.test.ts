import { afterEach, describe, expect, it } from "bun:test";
import { createMcpSession, gqlRequest } from "../src/api.ts";
import { LEGACY_SCHEMA_INTROSPECTION } from "../../web/test/fixtures/legacy-schema-introspection.ts";

const originalFetch = globalThis.fetch;

const MODERN_SCHEMA_INTROSPECTION = {
  __schema: {
    queryType: LEGACY_SCHEMA_INTROSPECTION.__schema.queryType,
    types: LEGACY_SCHEMA_INTROSPECTION.__schema.types.map((type) =>
      ["Actor", "ApiKey", "ActorInvitation", "Team", "Label", "Webhook"].includes(type.name)
        ? { ...type, fields: [...(type.fields ?? []), { name: "workspaceId" }] }
        : type,
    ),
  },
};

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

  it("detects concurrent endpoints independently and preserves each contract", async () => {
    const requests: Array<{ endpoint: string; query: string; headers: Headers }> = [];
    let releaseModernProbe!: (response: Response) => void;
    const modernProbe = new Promise<Response>((resolve) => {
      releaseModernProbe = resolve;
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = new URL(String(input)).origin;
      const query = JSON.parse(String(init?.body)).query as string;
      const headers = new Headers(init?.headers);
      if (query.includes("__schema")) {
        if (endpoint === "http://modern.test") return modernProbe;
        return new Response(JSON.stringify({ data: LEGACY_SCHEMA_INTROSPECTION }), { status: 200 });
      }
      requests.push({ endpoint, query, headers });
      return new Response(JSON.stringify({ data: { viewer: { id: endpoint } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const query = `query Surface($workspaceId: ID!, $argumentWorkspaceId: ID!) {
      viewer { id selected: workspaceId }
      team(workspaceId: $argumentWorkspaceId) @include(if: true) { id }
    }`;
    const modern = gqlRequest(
      { url: "http://modern.test", apiKey: "modern-key", workspaceId: "modern-workspace" },
      query,
      { workspaceId: "unused", argumentWorkspaceId: "unused" },
    );
    const legacy = gqlRequest(
      { url: "http://legacy-concurrent.test", apiKey: "legacy-key" },
      query,
      { workspaceId: "unused", argumentWorkspaceId: "unused" },
    );

    await legacy;
    releaseModernProbe(
      new Response(JSON.stringify({ data: MODERN_SCHEMA_INTROSPECTION }), { status: 200 }),
    );
    await modern;

    const modernRequest = requests.find((request) => request.endpoint === "http://modern.test");
    const legacyRequest = requests.find(
      (request) => request.endpoint === "http://legacy-concurrent.test",
    );
    expect(modernRequest?.query).toContain("selected: workspaceId");
    expect(modernRequest?.headers.get("x-workspace-id")).toBe("modern-workspace");
    expect(modernRequest?.headers.get("x-prime-board-mcp-auth")).toBe("required");
    expect(legacyRequest?.query).not.toMatch(/\bworkspaceId\b/);
    expect(legacyRequest?.query).toContain("@include(if: true)");
    expect(legacyRequest?.headers.has("x-workspace-id")).toBe(false);
    expect(legacyRequest?.headers.get("x-prime-board-mcp-auth")).toBe("required");
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
