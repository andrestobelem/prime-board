// PRB-651: PostgreSQL debe usar la misma ACL ANY que SQLite.
import { describe, expect, it } from "bun:test";
import type { ActorRow } from "../auth/viewer.ts";
import type { Persistence, PersistenceResult, SqlParameters } from "../db/persistence.ts";
import { canAccessPostgresInitiative, type PostgresInitiativeRow } from "./postgres-initiatives.ts";
import type { TeamRow } from "./teams.ts";

const initiative: PostgresInitiativeRow = {
  id: "initiative-651",
  name: "PRB-651 multi-Team",
  description: null,
  state: "planned",
  target_date: null,
  owner_id: null,
  created_at: "2026-09-09T00:00:00.000Z",
  updated_at: "2026-09-09T00:00:00.000Z",
  archived_at: null,
};

const teams: TeamRow[] = [
  {
    id: "team-651-a",
    workspace_id: "workspace-651",
    name: "Team A",
    key: "A651",
    description: null,
    next_issue_number: 1,
    default_state_id: null,
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:00:00.000Z",
    archived_at: null,
    visibility: "private",
    access_policy: "team_members",
  },
  {
    id: "team-651-b",
    workspace_id: "workspace-651",
    name: "Team B",
    key: "B651",
    description: null,
    next_issue_number: 1,
    default_state_id: null,
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:00:00.000Z",
    archived_at: null,
    visibility: "private",
    access_policy: "team_members",
  },
];

const actor = (id: string): ActorRow => ({
  id,
  name: id,
  email: null,
  type: "agent",
  workspace_role: "member",
  status: "active",
  avatar_url: null,
  created_at: "2026-09-09T00:00:00.000Z",
  updated_at: "2026-09-09T00:00:00.000Z",
});

function fakePersistence(
  teamMembers: Record<string, string[]>,
  row: PostgresInitiativeRow = initiative,
  initiativeTeams: readonly TeamRow[] = teams,
): Persistence {
  return {
    async one<Row extends object>(sql: string, params: SqlParameters = []): Promise<Row | null> {
      if (sql.includes("FROM initiatives")) return row as Row;
      if (sql.includes("FROM teams")) {
        return (teams.find((team) => team.id === params[0]) as Row | undefined) ?? null;
      }
      if (sql.includes("FROM team_memberships")) {
        const [teamId, actorId] = params;
        return teamMembers[String(teamId)]?.includes(String(actorId))
          ? ({ ok: true } as Row)
          : null;
      }
      throw new Error(`Unexpected one query: ${sql}`);
    },
    async many<Row extends object>(sql: string): Promise<readonly Row[]> {
      if (sql.includes("FROM initiative_projects")) return [] as Row[];
      if (sql.includes("FROM initiative_teams")) {
        return initiativeTeams.map((team) => ({ team_id: team.id })) as Row[];
      }
      if (sql.includes("FROM project_teams")) return [] as Row[];
      throw new Error(`Unexpected many query: ${sql}`);
    },
    async execute<Row extends object>(): Promise<PersistenceResult<Row>> {
      return { rows: [], rowCount: 0 };
    },
    async transaction<Result>(): Promise<Result> {
      throw new Error("Unexpected transaction");
    },
    async close(): Promise<void> {},
  };
}

describe("PostgreSQL Initiative multi-Team ACL", () => {
  it("autoriza al miembro de un Team, a todos y a nadie según corresponda", async () => {
    const persistence = fakePersistence({
      "team-651-a": ["member-one", "member-all"],
      "team-651-b": ["member-all"],
    });

    await expect(
      canAccessPostgresInitiative(persistence, actor("member-one"), initiative.id),
    ).resolves.toBe(true);
    await expect(
      canAccessPostgresInitiative(persistence, actor("member-all"), initiative.id),
    ).resolves.toBe(true);
    await expect(
      canAccessPostgresInitiative(persistence, actor("outsider"), initiative.id),
    ).resolves.toBe(false);
  });

  it("mantiene una Initiative sin Teams visible para cualquier viewer", async () => {
    const empty = { ...initiative, id: "initiative-651-empty" };
    const persistence = fakePersistence({}, empty, []);

    await expect(
      canAccessPostgresInitiative(persistence, actor("outsider"), empty.id),
    ).resolves.toBe(true);
  });
});
