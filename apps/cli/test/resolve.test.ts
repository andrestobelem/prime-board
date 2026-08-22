import { afterEach, describe, expect, it } from "bun:test";
import { resolveLabels } from "../src/resolve.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CLI reference resolution", () => {
  it("rejects an unqualified duplicate label with an actionable scope", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: {
          labels: [
            { id: "workspace-label", name: "urgent", teamId: null },
            { id: "team-label", name: "urgent", teamId: "team-a" },
          ],
          team: { key: "PB", name: "Platform" },
        },
      })) as typeof fetch;

    await expect(
      resolveLabels(
        { url: "http://board.test", apiKey: "pb_test", workspaceId: "workspace-a" },
        "team-a",
        ["urgent"],
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Label name is ambiguous: urgent; use its scope",
    });
  });
});
