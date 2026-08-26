import { afterEach, describe, expect, it } from "bun:test";
import { gqlRequest } from "../src/api.ts";
import { LEGACY_SCHEMA_INTROSPECTION } from "../../web/test/fixtures/legacy-schema-introspection.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CLI legacy Workspace compatibility", () => {
  it("removes unsupported scoped fields and headers after the 4295813 SDL probe", async () => {
    const requests: Array<{ query: string; headers: Headers }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      requests.push({ query, headers: new Headers(init?.headers) });
      if (query.includes("__schema")) {
        return new Response(JSON.stringify({ data: LEGACY_SCHEMA_INTROSPECTION }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { viewer: { id: "actor" } } }), { status: 200 });
    }) as unknown as typeof fetch;

    await gqlRequest(
      { url: "http://legacy.test", apiKey: "legacy-key", workspaceId: "stale-workspace" },
      '{ viewer { id workspaceId name } team(key: "PB") { id workspaceId key } }',
    );

    const request = requests[1];
    expect(request?.query).not.toContain("workspaceId");
    expect(request?.headers.has("x-workspace-id")).toBe(false);
  });
});
