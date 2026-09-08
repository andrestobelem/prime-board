import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { Persistence } from "../db/persistence.ts";
import { WebhookDispatcher, signPayload, type WebhookRow } from "./dispatcher.ts";

function fakePersistence(
  hooks: WebhookRow | readonly WebhookRow[],
  workspaceId = "workspace-1",
  state: { membershipStatus: "active" | "suspended" | "left" } = {
    membershipStatus: "active",
  },
  queries: string[] = [],
  resourceWorkspaceId = workspaceId,
  workspaceIds: readonly string[] = [workspaceId],
): Persistence {
  const rows = Array.isArray(hooks) ? hooks : [hooks];
  return {
    one: async <Row extends object>(sql: string, params = []) => {
      const hook = rows[0];
      if (sql.includes("workspace_memberships")) {
        return {
          id: hook?.owner_id ?? null,
          status: state.membershipStatus,
          workspace_role: "admin",
        } as Row;
      }
      if (sql.includes("FROM workspace ")) {
        return typeof params[0] === "string" && workspaceIds.includes(params[0])
          ? ({ id: params[0] } as Row)
          : null;
      }
      if (sql.includes("workspace_role")) {
        return { id: hook?.owner_id ?? null, status: "active", workspace_role: "admin" } as Row;
      }
      if (sql.includes("FROM teams")) {
        const hasMatchingWorkspace = params.length < 2 || params[1] === resourceWorkspaceId;
        return params[0] === hook?.team_id && hasMatchingWorkspace
          ? ({ id: hook.team_id } as Row)
          : null;
      }
      return null;
    },
    many: async <Row extends object>(sql: string, params = []) => {
      queries.push(`${sql} ${JSON.stringify(params)}`);
      if (sql.includes("FROM workspace ")) return workspaceIds.map((id) => ({ id })) as Row[];
      if (sql.includes("FROM webhooks")) {
        return sql.includes("workspace_id = $1")
          ? (rows.filter(
              (hook) => hook.workspace_id == null || hook.workspace_id === params[0],
            ) as Row[])
          : (rows as Row[]);
      }
      return rows as Row[];
    },
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

  it("falla cerrado para un Workspace explícito ajeno en PostgreSQL", async () => {
    const hook: WebhookRow = {
      id: "hook-foreign-workspace",
      url: "https://example.test/foreign-workspace",
      secret: "SUPERSECRET",
      events: '["issue.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: "team-1",
    };
    const requests: Request[] = [];
    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("ok");
    }) as typeof fetch;
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [] },
      fakePersistence(hook, "workspace-a"),
    );

    dispatcher.emitForWorkspace(
      "workspace-b",
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      { issueId: "issue-1", teamId: "team-1" },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(0);
  });

  it("filtra hooks PostgreSQL con Workspace distinto", async () => {
    const hook: WebhookRow = {
      id: "hook-foreign-row",
      url: "https://example.test/foreign-row",
      secret: "SUPERSECRET",
      events: '["issue.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: "team-1",
      workspace_id: "workspace-b",
    };
    const requests: Request[] = [];
    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("ok");
    }) as typeof fetch;
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [] },
      fakePersistence(hook),
    );

    dispatcher.emitForWorkspace(
      "workspace-1",
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      { teamId: "team-1" },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(0);
  });

  it("entrega team.created con el scope snapshot aunque el Team ya no exista", async () => {
    const hook: WebhookRow = {
      id: "hook-team-created-snapshot",
      url: "https://example.test/team-created-snapshot",
      secret: "SUPERSECRET",
      events: '["team.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: null,
    };
    const requests: Request[] = [];
    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("ok");
    }) as typeof fetch;
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [] },
      fakePersistence(hook),
    );

    dispatcher.emitForWorkspace(
      "workspace-1",
      "team.created",
      { id: "admin-1", name: "admin", type: "human" },
      {
        id: "team-created",
        teamId: "team-created",
        key: "NEW",
        name: "New Team",
        _teamWorkspaceId: "workspace-1",
        _teamOwnerIds: ["admin-1"],
      },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(1);
    const body = JSON.parse(await requests[0]!.text()) as {
      event: string;
      workspaceId: string;
      data: Record<string, unknown>;
    };
    expect(body).toMatchObject({
      event: "team.created",
      workspaceId: "workspace-1",
      data: { id: "team-created", key: "NEW" },
    });
    expect(body.data).not.toHaveProperty("_teamWorkspaceId");
    expect(body.data).not.toHaveProperty("_teamOwnerIds");
  });

  it("falla cerrado para recursos PostgreSQL inexistentes", async () => {
    const hook: WebhookRow = {
      id: "hook-missing-resource",
      url: "https://example.test/missing-resource",
      secret: "SUPERSECRET",
      events: '["*"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: null,
    };
    const requests: Request[] = [];
    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("ok");
    }) as typeof fetch;
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [] },
      fakePersistence(hook),
    );

    dispatcher.emitForWorkspace(
      "workspace-1",
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      { issueId: "missing-issue" },
    );
    dispatcher.emitForWorkspace(
      "workspace-1",
      "project.updated",
      { id: "admin-1", name: "admin", type: "human" },
      { projectId: "missing-project" },
    );
    dispatcher.emitForWorkspace(
      "workspace-1",
      "team.deleted",
      { id: "admin-1", name: "admin", type: "human" },
      { id: "missing-team", teamId: "missing-team", _teamOwnerIds: ["admin-1"] },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(0);
  });

  it("rechaza recursos de otro Workspace en PostgreSQL", async () => {
    const hook: WebhookRow = {
      id: "hook-resource-scope",
      url: "https://example.test/resource-scope",
      secret: "SUPERSECRET",
      events: '["issue.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: "team-1",
      workspace_id: "workspace-b",
    };
    const requests: string[] = [];
    const fetchFn = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return new Response("ok");
      },
      { preconnect: fetch.preconnect },
    );
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [] },
      fakePersistence(hook, "workspace-b", undefined, [], "workspace-a"),
    );

    dispatcher.emitForWorkspace(
      "workspace-b",
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      { issueId: "issue-1", teamId: "team-1" },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(0);
  });

  it("consulta solo los hooks del Workspace efectivo en PostgreSQL", async () => {
    const hookA: WebhookRow = {
      id: "hook-workspace-a",
      url: "https://example.test/workspace-a",
      secret: "SECRET-A",
      events: '["workspace.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: null,
      workspace_id: "workspace-a",
    };
    const hookB: WebhookRow = {
      ...hookA,
      id: "hook-workspace-b",
      url: "https://example.test/workspace-b",
      secret: "SECRET-B",
      workspace_id: "workspace-b",
    };
    const requests: string[] = [];
    const queries: string[] = [];
    const fetchFn = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return new Response("ok");
      },
      { preconnect: fetch.preconnect },
    );
    const dispatcher = new WebhookDispatcher(
      new Database(":memory:"),
      { fetchFn, retryDelays: [] },
      fakePersistence(
        [hookA, hookB],
        "workspace-b",
        undefined,
        queries,
        "workspace-b",
        ["workspace-a", "workspace-b"],
      ),
    );

    dispatcher.emitForWorkspace(
      "workspace-b",
      "workspace.created",
      { id: "admin-1", name: "admin", type: "human" },
      { id: "workspace-b" },
    );
    await dispatcher.idle();

    expect(requests).toEqual(["https://example.test/workspace-b"]);
    const hooksQuery = queries.find((query) => query.includes("FROM webhooks"));
    expect(hooksQuery).toContain("workspace_id = $1");
    expect(hooksQuery).toContain("workspace-b");
  });

  it("detiene los reintentos cuando la Membership PostgreSQL queda suspendida o retirada", async () => {
    for (const membershipStatus of ["suspended", "left"] as const) {
      const hook: WebhookRow = {
        id: `hook-membership-${membershipStatus}`,
        url: `https://example.test/membership-${membershipStatus}`,
        secret: "SUPERSECRET",
        events: '["issue.created"]',
        enabled: true,
        created_at: "2026-01-01T00:00:00.000Z",
        owner_id: "admin-1",
        team_id: "team-1",
      };
      const state: { membershipStatus: "active" | "suspended" | "left" } = {
        membershipStatus: "active",
      };
      let attempts = 0;
      const fetchFn = Object.assign(
        async (_input: Parameters<typeof fetch>[0]) => {
          attempts += 1;
          state.membershipStatus = membershipStatus;
          return new Response("retry", { status: 503 });
        },
        { preconnect: fetch.preconnect },
      );
      const dispatcher = new WebhookDispatcher(
        new Database(":memory:"),
        { fetchFn, retryDelays: [0] },
        fakePersistence(hook, "workspace-1", state),
      );

      dispatcher.emitForWorkspace(
        "workspace-1",
        "issue.created",
        { id: "admin-1", name: "admin", type: "human" },
        { teamId: "team-1" },
      );
      await dispatcher.idle();

      expect(attempts, membershipStatus).toBe(1);
    }
  });
});
