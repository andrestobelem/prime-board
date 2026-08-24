import { describe, expect, it } from "bun:test";
import type { Persistence, PersistenceResult, SqlParameters } from "../db/persistence.ts";
import { resolvePostgresAuth } from "./postgres-viewer.ts";
import type { ActorRow } from "./viewer.ts";

const actor: ActorRow = {
  id: "actor-1",
  name: "Global admin identity",
  email: null,
  type: "agent",
  // Estos valores no deben controlar el acceso efectivo al Workspace.
  workspace_role: "admin",
  status: "suspended",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

type Fixture = {
  grant?: boolean;
  membershipActive?: boolean;
  membershipWorkspace?: string;
  workspaceUrlKey?: string;
};

function fakePersistence(fixture: Fixture = {}): Persistence {
  const calls: string[] = [];
  const key = { id: "key-1", actor_id: actor.id, expires_at: null };
  const persistence: Persistence = {
    async one<Row extends object>(sql: string): Promise<Row | null> {
      calls.push(sql);
      if (sql.includes("FROM api_keys")) return key as Row;
      if (sql.includes("FROM actors")) return actor as Row;
      throw new Error(`Unexpected one query: ${sql}`);
    },
    async many<Row extends object>(sql: string, params?: SqlParameters): Promise<readonly Row[]> {
      calls.push(sql);
      if (sql.includes("FROM api_key_team_limits")) return [];
      if (sql.includes("FROM api_key_workspaces")) {
        expect(sql).toContain("workspace_memberships");
        expect(sql).toContain("memberships.status = 'active'");
        const selector = params?.[2] ?? null;
        const workspace = fixture.membershipWorkspace ?? "workspace-a";
        const selected =
          selector === null ||
          selector === workspace ||
          selector === (fixture.workspaceUrlKey ?? workspace);
        if (!fixture.grant || !fixture.membershipActive || !selected) return [];
        return [
          {
            workspace_id: workspace,
            is_default: 1,
            workspace_role: "member",
            workspace_status: "active",
          } as Row,
        ];
      }
      if (sql.includes("SELECT scope")) return [{ scope: "read" } as Row];
      if (sql.includes("SELECT team_id")) return [];
      throw new Error(`Unexpected many query: ${sql}`);
    },
    async execute<Row extends object>(sql: string): Promise<PersistenceResult<Row>> {
      calls.push(sql);
      return { rows: [], rowCount: 1 };
    },
    async transaction<Result>(callback: (tx: Persistence) => Promise<Result>): Promise<Result> {
      return callback(persistence);
    },
    async close(): Promise<void> {},
  };
  return persistence;
}

describe("PostgreSQL authentication", () => {
  it("uses the selected active Membership instead of global Actor role/status", async () => {
    const auth = await resolvePostgresAuth(
      fakePersistence({ grant: true, membershipActive: true }),
      "Bearer pb_test-key",
      "workspace-a",
    );

    expect(auth).toMatchObject({
      keyId: "key-1",
      workspaceId: "workspace-a",
      workspaceRole: "member",
      workspaceStatus: "active",
      actor: {
        id: actor.id,
        workspace_role: "member",
        status: "active",
      },
    });
  });

  it("rejects a key without a Workspace grant", async () => {
    await expect(
      resolvePostgresAuth(
        fakePersistence({ grant: false, membershipActive: true }),
        "Bearer pb_test-key",
        "workspace-a",
      ),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
  });

  it("rejects a key when its Membership is not active", async () => {
    await expect(
      resolvePostgresAuth(
        fakePersistence({ grant: true, membershipActive: false }),
        "Bearer pb_test-key",
        "workspace-a",
      ),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
  });

  it("rejects a selector outside the granted Workspace", async () => {
    await expect(
      resolvePostgresAuth(
        fakePersistence({ grant: true, membershipActive: true }),
        "Bearer pb_test-key",
        "workspace-b",
      ),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
  });
});
