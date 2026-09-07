import { describe, expect, it } from "bun:test";
import type { ActorRow } from "../auth/viewer.ts";
import type { Persistence, PersistenceResult, SqlParameters } from "../db/persistence.ts";
import type { ActivityRow } from "./activity.ts";
import {
  listPostgresInboxActivity,
  mapPostgresInboxActivity,
  type PostgresInboxActivityRow,
} from "./postgres-inbox.ts";
import type { TeamRow } from "./teams.ts";

const viewer: ActorRow = {
  id: "viewer-a",
  name: "Viewer A",
  email: null,
  type: "agent",
  workspace_role: "member",
  status: "active",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const team: TeamRow = {
  id: "team-a",
  name: "Team A",
  key: "A",
  description: null,
  next_issue_number: 2,
  default_state_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  visibility: "public",
  access_policy: "workspace_members",
};

interface MembershipFixture {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly status: "active" | "suspended" | "left";
}

function activity(id: string, actorId: string, issueId = "issue-a"): PostgresInboxActivityRow {
  const row: ActivityRow = {
    id,
    issue_id: issueId,
    actor_id: actorId,
    type: "created",
    payload: JSON.stringify({}),
    created_at: "2026-01-01T00:00:00.000Z",
    workspace_id: null,
  };
  return {
    ...row,
    is_read: 0,
    is_archived: 0,
    issue_assignee_id: viewer.id,
    issue_team_id: team.id,
  };
}

function persistenceFor(
  rows: readonly PostgresInboxActivityRow[],
  memberships: readonly MembershipFixture[],
  issueWorkspaces: Readonly<Record<string, string>>,
): Persistence {
  return {
    one: async <Row extends object>(sql: string) => {
      if (sql.includes("FROM teams")) return team as Row;
      return null;
    },
    many: async <Row extends object>(sql: string, params: SqlParameters = []) => {
      if (!sql.includes("workspace_memberships") || !sql.includes("i.workspace_id = $3")) {
        throw new Error("Inbox lookup must enforce the effective Workspace");
      }
      if (params[0] !== viewer.id || params[2] !== "workspace-a") {
        throw new Error("Inbox lookup must use the effective Workspace");
      }
      return rows.filter(
        (row) =>
          issueWorkspaces[row.issue_id] === params[2] &&
          memberships.some(
            (membership) =>
              membership.actorId === row.actor_id && membership.workspaceId === params[2],
          ),
      ) as Row[];
    },
    execute: async <Row extends object>() =>
      ({ rows: [], rowCount: 0 }) satisfies PersistenceResult<Row>,
    transaction: async () => {
      throw new Error("transaction is not used by this test");
    },
    close: async () => undefined,
  };
}

describe("PostgreSQL Inbox Workspace scope", () => {
  it("excludes foreign actors, preserves suspended/left history, and maps a non-null Workspace", async () => {
    const rows = [
      activity("activity-a", "actor-a"),
      activity("activity-suspended", "actor-suspended"),
      activity("activity-left", "actor-left"),
      activity("activity-b", "actor-b", "issue-b"),
    ];
    const persistence = persistenceFor(
      rows,
      [
        { actorId: "actor-a", workspaceId: "workspace-a", status: "active" },
        { actorId: "actor-suspended", workspaceId: "workspace-a", status: "suspended" },
        { actorId: "actor-left", workspaceId: "workspace-a", status: "left" },
        { actorId: "actor-b", workspaceId: "workspace-b", status: "active" },
      ],
      {
        "issue-a": "workspace-a",
        "issue-b": "workspace-b",
      },
    );

    const visible = await listPostgresInboxActivity(persistence, viewer, "workspace-a");
    expect(visible.map((row) => row.id)).toEqual(
      expect.arrayContaining(["activity-a", "activity-suspended", "activity-left"]),
    );
    expect(visible).toHaveLength(3);
    expect(visible.map((row) => row.id)).not.toContain("activity-b");
    expect(visible.map((row) => mapPostgresInboxActivity(row, "workspace-a").workspaceId)).toEqual([
      "workspace-a",
      "workspace-a",
      "workspace-a",
    ]);
  });
});
