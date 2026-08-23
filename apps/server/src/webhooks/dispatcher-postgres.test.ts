import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { Persistence } from "../db/persistence.ts";
import { WebhookDispatcher, signPayload, type WebhookRow } from "./dispatcher.ts";

function fakePersistence(hook: WebhookRow): Persistence {
  return {
    one: async <Row extends object>(sql: string) => {
      if (sql.includes("workspace_role")) {
        return { id: hook.owner_id, status: "active", workspace_role: "admin" } as Row;
      }
      if (sql.includes("FROM teams")) return { id: hook.team_id } as Row;
      return null;
    },
    many: async <Row extends object>() => [hook] as Row[],
    execute: async () => ({ rows: [], rowCount: 0 }),
    transaction: async () => {
      throw new Error("not used");
    },
    close: async () => undefined,
  };
}

describe("PostgreSQL webhook dispatcher", () => {
  it("reads hooks asynchronously, signs deliveries, retries, and never sends the secret", async () => {
    const hook: WebhookRow = {
      id: "hook-1",
      url: "https://example.test/hook",
      secret: "SUPERSECRET",
      events: '["issue.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: "team-1",
    };
    const requests: Array<{ body: BodyInit | null | undefined; headers?: HeadersInit }> = [];
    let failuresLeft = 1;
    const fetchFn = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ body: init?.body, headers: init?.headers });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return new Response("retry", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [0] },
      fakePersistence(hook),
    );

    dispatcher.emit(
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      {
        teamId: "team-1",
        identifier: "PRB-1",
      },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(2);
    const body = requests[1]?.body as string;
    expect(body).not.toContain("SUPERSECRET");
    expect(requests[1]?.headers).toMatchObject({
      "x-primeboard-signature": signPayload("SUPERSECRET", body),
    });
  });
});
