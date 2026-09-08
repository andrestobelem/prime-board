import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { Persistence, SqlParameters } from "../db/persistence.ts";
import { WebhookDispatcher, signPayload, type WebhookRow } from "./dispatcher.ts";

type WorkspaceMembershipStatus = "active" | "suspended" | "left";

function fakePersistence(
  hook: WebhookRow,
  membership: { status: WorkspaceMembershipStatus } = { status: "active" },
  workspaceId = "workspace-1",
): Persistence {
  async function one<Row extends object>(sql: string, params?: SqlParameters): Promise<Row | null>;
  async function one(sql: string, params: SqlParameters = []): Promise<object | null> {
    if (sql.includes("workspace_memberships")) {
      if (params[1] !== workspaceId || membership.status !== "active") return null;
      return {
        id: hook.owner_id,
        actor_id: hook.owner_id,
        workspace_id: workspaceId,
        role: "admin",
        workspace_role: "admin",
        status: "active",
      };
    }
    if (sql.includes("workspace_role")) {
      return { id: hook.owner_id, status: "active", workspace_role: "admin" };
    }
    if (sql.includes("FROM teams")) {
      return params[0] === hook.team_id ? { id: hook.team_id } : null;
    }
    return null;
  }

  async function many<Row extends object>(
    _sql: string,
    _params?: SqlParameters,
  ): Promise<readonly Row[]>;
  async function many(): Promise<readonly object[]> {
    return [hook];
  }

  return {
    one,
    many,
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

    dispatcher.emitForWorkspace(
      "workspace-1",
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

  const membershipStatuses: readonly WorkspaceMembershipStatus[] = ["active", "suspended", "left"];
  for (const status of membershipStatuses) {
    it(`checks the owner's PostgreSQL Workspace Membership when status is ${status}`, async () => {
      const hook: WebhookRow = {
        id: `hook-${status}`,
        url: "https://example.test/hook",
        secret: "SUPERSECRET",
        events: '["issue.created"]',
        enabled: true,
        created_at: "2026-01-01T00:00:00.000Z",
        owner_id: "owner-1",
        team_id: "team-1",
      };
      const requests: Request[] = [];
      const fetchFn: typeof fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          requests.push(new Request(input, init));
          return new Response("ok");
        },
        { preconnect: fetch.preconnect },
      );
      const dispatcher = new WebhookDispatcher(
        new Database(":memory:"),
        { fetchFn, retryDelays: [] },
        fakePersistence(hook, { status }),
      );

      dispatcher.emitForWorkspace(
        "workspace-1",
        "issue.created",
        { id: "owner-1", name: "owner", type: "human" },
        { teamId: "team-1" },
      );
      await dispatcher.idle();

      expect(requests).toHaveLength(status === "active" ? 1 : 0);
    });
  }

  it("rechecks the PostgreSQL Workspace Membership before each retry", async () => {
    const hook: WebhookRow = {
      id: "hook-retry-membership",
      url: "https://example.test/hook",
      secret: "SUPERSECRET",
      events: '["issue.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "owner-1",
      team_id: "team-1",
    };
    const membership: { status: WorkspaceMembershipStatus } = { status: "active" };
    let attempts = 0;
    const fetchFn = Object.assign(
      async (): Promise<Response> => {
        attempts += 1;
        membership.status = "suspended";
        return new Response("retry", { status: 503 });
      },
      { preconnect: fetch.preconnect },
    );
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [0] },
      fakePersistence(hook, membership),
    );

    dispatcher.emitForWorkspace(
      "workspace-1",
      "issue.created",
      { id: "owner-1", name: "owner", type: "human" },
      { teamId: "team-1" },
    );
    await dispatcher.idle();

    expect(attempts).toBe(1);
  });
});
