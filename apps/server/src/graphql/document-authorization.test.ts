import { describe, expect, it } from "bun:test";
import type { ActorRow } from "../auth/viewer.ts";
import type { Persistence, SqlParameters, PersistenceResult } from "../db/persistence.ts";
import type { Context } from "./context.ts";
import { assertPostgresInitiativeAccess } from "./document-resolvers.ts";

type FakeOptions = {
  teamIds?: string[];
  archivedAt?: string | null;
  member?: boolean;
};

const viewer: ActorRow = {
  id: "actor-1",
  name: "Test actor",
  email: null,
  type: "agent",
  workspace_role: "admin",
  status: "active",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function fakePersistence(options: FakeOptions = {}): Persistence {
  const teamIds = options.teamIds ?? ["team-1"];
  const initiative = {
    id: "initiative-1",
    name: "Test initiative",
    description: null,
    state: "planned" as const,
    target_date: null,
    owner_id: viewer.id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
  };
  const team = {
    id: "team-1",
    name: "Test team",
    key: "TEST",
    description: null,
    next_issue_number: 1,
    default_state_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: options.archivedAt ?? null,
    visibility: "public" as const,
    access_policy: "team_members" as const,
  };
  return {
    async one<Row extends object>(sql: string, _params?: SqlParameters): Promise<Row | null> {
      if (sql.includes("FROM initiatives")) return initiative as Row;
      if (sql.includes("FROM teams")) return team as Row;
      if (sql.includes("FROM team_memberships")) {
        return options.member ? ({ present: true } as Row) : null;
      }
      throw new Error(`Unexpected fake query: ${sql}`);
    },
    async many<Row extends object>(sql: string, _params?: SqlParameters): Promise<readonly Row[]> {
      if (sql.includes("FROM initiative_teams")) {
        return teamIds.map((team_id) => ({ team_id }) as Row);
      }
      if (sql.includes("FROM initiative_projects")) return [];
      throw new Error(`Unexpected fake query: ${sql}`);
    },
    async execute<Row extends object>(
      _sql: string,
      _params?: SqlParameters,
    ): Promise<PersistenceResult<Row>> {
      return { rows: [], rowCount: 0 };
    },
    async transaction<Result>(callback: (tx: Persistence) => Promise<Result>): Promise<Result> {
      return callback(this);
    },
    async close(): Promise<void> {},
  };
}

function context(
  persistence: Persistence,
  workspaceRole: ActorRow["workspace_role"],
  teamIds: string[] | null,
) {
  const actor = { ...viewer, workspace_role: workspaceRole };
  return {
    persistence,
    viewer: actor,
    auth: {
      actor,
      keyId: "fake-key",
      workspaceId: "workspace-1",
      workspaceRole,
      workspaceStatus: "active" as const,
      scopes: ["read", "write", "admin"] as const,
      teamIds,
      expiresAt: null,
    },
  } as unknown as Context;
}

describe("PostgreSQL Initiative authorization", () => {
  it("rejects writes through an archived Team, including Workspace admins", async () => {
    const persistence = fakePersistence({ archivedAt: "2026-01-02T00:00:00.000Z" });

    await expect(
      assertPostgresInitiativeAccess(context(persistence, "admin", null), "initiative-1"),
    ).rejects.toMatchObject({
      extensions: { code: "VALIDATION_FAILED" },
    });
  });

  it("checks API key Team limits before allowing an Initiative write", async () => {
    const persistence = fakePersistence();

    await expect(
      assertPostgresInitiativeAccess(
        context(persistence, "admin", ["different-team"]),
        "initiative-1",
      ),
    ).rejects.toMatchObject({
      extensions: { code: "UNAUTHORIZED" },
    });
  });

  it("keeps active admin and unrestricted no-Team access", async () => {
    await expect(
      assertPostgresInitiativeAccess(context(fakePersistence(), "admin", null), "initiative-1"),
    ).resolves.toBeUndefined();
    await expect(
      assertPostgresInitiativeAccess(
        context(fakePersistence({ teamIds: [] }), "admin", null),
        "initiative-1",
      ),
    ).resolves.toBeUndefined();
  });
});
