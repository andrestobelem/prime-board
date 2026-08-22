import { afterEach, describe, expect, it } from "bun:test";
import { gqlRequest } from "../src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CLI Workspace transport", () => {
  it("sends the explicit Workspace header and no credential in the payload", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: { workspace: { id: "workspace-b" } } });
    }) as typeof fetch;

    await gqlRequest(
      {
        url: "http://board.test",
        apiKey: "pb_secret",
        workspaceId: "workspace-b",
        workspaceUrlKey: "beta",
      },
      "{ workspace { id } }",
    );

    expect(request?.headers.get("x-workspace-id")).toBe("workspace-b");
    expect(await request?.text()).not.toContain("pb_secret");
  });

  it("does not add a Workspace header for legacy singleton profiles", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: { workspace: { id: "workspace-a" } } });
    }) as typeof fetch;

    await gqlRequest({ url: "http://board.test", apiKey: "pb_secret" }, "{ workspace { id } }");

    expect(request?.headers.has("x-workspace-id")).toBe(false);
  });
});
