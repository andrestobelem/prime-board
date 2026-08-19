import { afterEach, describe, expect, it } from "bun:test";
import { createMcpSession } from "../src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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
    expect(requests).toEqual([{ authorization: "Bearer pb_secret" }]);
  });
});
