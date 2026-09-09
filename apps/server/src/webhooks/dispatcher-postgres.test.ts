import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { Persistence } from "../db/persistence.ts";
import { WebhookDispatcher, signPayload, type WebhookRow } from "./dispatcher.ts";

function fakePersistence(
  input: WebhookRow | readonly WebhookRow[],
  workspaceId = "workspace-1",
): Persistence {
  const hooks = Array.isArray(input) ? [...input] : [input];
  return {
    one: async <Row extends object>(sql: string, params = []) => {
      if (sql.includes("FROM workspace")) {
        return params[0] === workspaceId ? ({ id: workspaceId } as Row) : null;
      }
      if (sql.includes("FROM issues")) {
        return params[0] === "issue-1" ? ({ id: "issue-1", team_id: "team-1" } as Row) : null;
      }
      if (sql.includes("workspace_role")) {
        return hooks[0]
          ? ({ id: hooks[0].owner_id, status: "active", workspace_role: "admin" } as Row)
          : null;
      }
      if (sql.includes("FROM teams")) {
        return params[0] === "team-1" ? ({ id: "team-1" } as Row) : null;
      }
      return null;
    },
    many: async <Row extends object>(sql: string) =>
      sql.includes("FROM workspace") ? ([{ id: workspaceId }] as Row[]) : (hooks as Row[]),
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
        id: "issue-1",
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

  it("mantiene la semántica legacy de issueId", async () => {
    const hook: WebhookRow = {
      id: "hook-legacy-issue-id",
      url: "https://example.test/legacy-issue-id",
      secret: "fixture-secret",
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
      fakePersistence(hook),
    );

    dispatcher.emitForWorkspace(
      "workspace-1",
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      { issueId: "issue-1", teamId: "team-1" },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(1);
  });

  it("falla cerrado para una Issue canónica inexistente en hooks globales y limitados", async () => {
    const globalHook: WebhookRow = {
      id: "hook-global-missing-issue",
      url: "https://example.test/global-missing-issue",
      secret: "fixture-secret-global",
      events: '["issue.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      owner_id: "admin-1",
      team_id: null,
    };
    const limitedHook: WebhookRow = {
      id: "hook-limited-missing-issue",
      url: "https://example.test/limited-missing-issue",
      secret: "fixture-secret-limited",
      events: '["issue.created"]',
      enabled: true,
      created_at: "2026-01-01T00:00:01.000Z",
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
      fakePersistence([globalHook, limitedHook]),
    );

    dispatcher.emitForWorkspace(
      "workspace-1",
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      { id: "missing-issue", teamId: "team-1" },
    );
    await dispatcher.idle();

    expect(requests).toHaveLength(0);
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \t\n"],
  ])(
    "falla cerrado para teamId %s en el seam de PostgreSQL",
    async (_caseName: string, teamId: string) => {
      const globalHook: WebhookRow = {
        id: "hook-global-invalid-team",
        url: "https://example.test/global-invalid-team",
        secret: "fixture-secret-global",
        events: '["issue.created"]',
        enabled: true,
        created_at: "2026-01-01T00:00:00.000Z",
        owner_id: "admin-1",
        team_id: null,
      };
      const limitedHook: WebhookRow = {
        id: "hook-limited-invalid-team",
        url: "https://example.test/limited-invalid-team",
        secret: "fixture-secret-limited",
        events: '["issue.created"]',
        enabled: true,
        created_at: "2026-01-01T00:00:01.000Z",
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
        fakePersistence([globalHook, limitedHook]),
      );

      for (const dispatch of ["implicit", "explicit"]) {
        requests.length = 0;
        const data = { id: "issue-1", teamId };
        if (dispatch === "implicit") {
          dispatcher.emit("issue.created", { id: "admin-1", name: "admin", type: "human" }, data);
        } else {
          dispatcher.emitForWorkspace(
            "workspace-1",
            "issue.created",
            { id: "admin-1", name: "admin", type: "human" },
            data,
          );
        }
        await dispatcher.idle();

        expect(requests).toHaveLength(0);
      }
    },
  );

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

  it("falla cerrado cuando _workspaceId está presente y no es string en PostgreSQL", async () => {
    const hook: WebhookRow = {
      id: "hook-invalid-workspace-metadata",
      url: "https://example.test/invalid-workspace-metadata",
      secret: "fixture-secret",
      events: '["issue.created"]',
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

    dispatcher.emit(
      "issue.created",
      { id: "admin-1", name: "admin", type: "human" },
      { id: "issue-1", teamId: "team-1", _workspaceId: undefined },
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
});
