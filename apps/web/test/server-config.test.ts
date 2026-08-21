import { afterEach, describe, expect, it } from "bun:test";
import { getServerAuthMode } from "../src/api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("server authentication mode", () => {
  it("detects local mode from the server config", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ authMode: "local" }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(getServerAuthMode()).resolves.toBe("local");
  });

  it("keeps API-key mode when the config endpoint is unavailable", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    await expect(getServerAuthMode()).resolves.toBe("api-key");
  });
});
