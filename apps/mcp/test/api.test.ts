import { afterEach, describe, expect, it } from "bun:test";
import { createMcpSession, safeEndpointUrl } from "../src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MCP endpoint redaction", () => {
  it("keeps only the origin and never exposes endpoint credentials", () => {
    const safe = safeEndpointUrl(
      "https://user:password@board.invalid/graphql/private?apiKey=pb_secret&note=arbitrary#fragment-secret",
    );
    expect(safe).toBe("https://board.invalid");
    expect(safe).not.toContain("password");
    expect(safe).not.toContain("pb_secret");
    expect(safe).not.toContain("arbitrary");
    expect(safe).not.toContain("fragment-secret");
  });

  it("redacts invalid endpoint strings completely", () => {
    const safe = safeEndpointUrl("not a URL token=pb_secret path-secret");
    expect(safe).toBe("[redacted-endpoint-url]");
    expect(safe).not.toContain("pb_secret");
    expect(safe).not.toContain("path-secret");
  });
});

describe("MCP effective Workspace session", () => {
  it("resolves context once and freezes the endpoint and credential", async () => {
    const requests: Array<{ authorization: string | null }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({
          data: {
            viewer: { id: "actor-1", name: "agent", type: "AGENT" },
            workspace: { id: "workspace-1", name: "Board", urlKey: "board" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const session = await createMcpSession({ url: "http://board.invalid", apiKey: "pb_secret" });

    expect(session).toMatchObject({
      url: "http://board.invalid",
      apiKey: "pb_secret",
      context: { workspaceId: "workspace-1", actorId: "actor-1" },
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.context)).toBe(true);
    expect(requests).toEqual([
      { authorization: "Bearer pb_secret" },
      { authorization: "Bearer pb_secret" },
    ]);
  });
});
