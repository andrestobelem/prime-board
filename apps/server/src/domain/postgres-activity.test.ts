import { describe, expect, it } from "bun:test";
import type { ActorRow } from "../auth/viewer.ts";
import type { Persistence, PersistenceResult, SqlParameters } from "../db/persistence.ts";
import type { ActivityRow } from "./activity.ts";
import { listPostgresActivity } from "./postgres-activity.ts";
import { getPostgresActorInWorkspace } from "./postgres-actors.ts";

interface MembershipFixture {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly role: "admin" | "member";
  readonly status: "active" | "suspended" | "left";
}

const actor = (
  id: string,
  status: ActorRow["status"] = "active",
  workspaceRole: ActorRow["workspace_role"] = "admin",
): ActorRow => ({
  id,
  name: id,
  email: null,
  type: "agent",
  workspace_role: workspaceRole,
  status,
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const activity = (id: string, actorId: string): ActivityRow => ({
  id,
  issue_id: "issue-1",
  actor_id: actorId,
  type: "created",
  payload: JSON.stringify({ title: id }),
  created_at: "2026-01-01T00:00:00.000Z",
  workspace_id: null,
});

function persistenceFor(
  activities: readonly ActivityRow[],
  actors: readonly ActorRow[],
  memberships: readonly MembershipFixture[],
): Persistence {
  return {
    one: async <Row extends object>(sql: string, params: SqlParameters = []) => {
      if (
        !sql.includes("workspace_memberships") ||
        !sql.includes("memberships.role AS workspace_role") ||
        !sql.includes("memberships.status AS status")
      ) {
        throw new Error("actor lookup must project the effective Workspace Membership");
      }
      const actorId = typeof params[0] === "string" ? params[0] : "";
      const workspaceId = typeof params[1] === "string" ? params[1] : "";
      const membership = memberships.find(
        (candidate) => candidate.actorId === actorId && candidate.workspaceId === workspaceId,
      );
      const candidate = actors.find((row) => row.id === actorId);
      const row =
        candidate && membership
          ? { ...candidate, workspace_role: membership.role, status: membership.status }
          : null;
      return row as Row | null;
    },
    many: async <Row extends object>(sql: string, params: SqlParameters = []) => {
      if (!sql.includes("workspace_memberships")) {
        throw new Error("Activity lookup must enforce the effective Workspace Membership");
      }
      const issueId = typeof params[0] === "string" ? params[0] : "";
      const workspaceId = typeof params[1] === "string" ? params[1] : "";
      const rows = activities.filter(
        (candidate) =>
          candidate.issue_id === issueId &&
          memberships.some(
            (membership) =>
              membership.actorId === candidate.actor_id && membership.workspaceId === workspaceId,
          ),
      );
      return rows as Row[];
    },
    execute: async <Row extends object>() =>
      ({ rows: [], rowCount: 0 }) satisfies PersistenceResult<Row>,
    transaction: async () => {
      throw new Error("transaction is not used by this test");
    },
    close: async () => undefined,
  };
}

describe("PostgreSQL Activity Workspace scope", () => {
  it("conserva Activity y autoría de Memberships suspendidas o retiradas", async () => {
    const actors = [
      actor("actor-a", "left", "admin"),
      actor("actor-b"),
      actor("actor-suspended"),
      actor("actor-left"),
    ];
    const persistence = persistenceFor(
      [
        activity("activity-a", "actor-a"),
        activity("activity-b", "actor-b"),
        activity("activity-suspended", "actor-suspended"),
        activity("activity-left", "actor-left"),
      ],
      actors,
      [
        { actorId: "actor-a", workspaceId: "workspace-a", role: "member", status: "active" },
        { actorId: "actor-b", workspaceId: "workspace-b", role: "admin", status: "active" },
        {
          actorId: "actor-suspended",
          workspaceId: "workspace-a",
          role: "member",
          status: "suspended",
        },
        { actorId: "actor-left", workspaceId: "workspace-a", role: "member", status: "left" },
      ],
    );

    await expect(listPostgresActivity(persistence, "issue-1", "workspace-a")).resolves.toEqual([
      activity("activity-a", "actor-a"),
      activity("activity-suspended", "actor-suspended"),
      activity("activity-left", "actor-left"),
    ]);
    await expect(
      getPostgresActorInWorkspace(persistence, "actor-a", "workspace-a"),
    ).resolves.toEqual(actor("actor-a", "active", "member"));
    await expect(
      getPostgresActorInWorkspace(persistence, "actor-suspended", "workspace-a"),
    ).resolves.toEqual(actor("actor-suspended", "suspended", "member"));
    await expect(
      getPostgresActorInWorkspace(persistence, "actor-left", "workspace-a"),
    ).resolves.toEqual(actor("actor-left", "left", "member"));
    await expect(
      getPostgresActorInWorkspace(persistence, "actor-b", "workspace-a"),
    ).resolves.toBeNull();
  });
});
