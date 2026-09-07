import { describe, expect, it } from "bun:test";
import type { ActorRow } from "../auth/viewer.ts";
import type { Persistence, PersistenceResult, SqlParameters } from "../db/persistence.ts";
import type { ActivityRow } from "./activity.ts";
import { listPostgresActivity } from "./postgres-activity.ts";
import { getPostgresActorInWorkspace } from "./postgres-actors.ts";

interface MembershipFixture {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly status: "active" | "suspended" | "left";
}

const actor = (id: string): ActorRow => ({
  id,
  name: id,
  email: null,
  type: "agent",
  workspace_role: "member",
  status: "active",
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
        !sql.includes("memberships.status = 'active'")
      ) {
        throw new Error("actor lookup must enforce the effective Workspace Membership");
      }
      const actorId = typeof params[0] === "string" ? params[0] : "";
      const workspaceId = typeof params[1] === "string" ? params[1] : "";
      const row = actors.find(
        (candidate) =>
          candidate.id === actorId &&
          memberships.some(
            (membership) =>
              membership.actorId === actorId &&
              membership.workspaceId === workspaceId &&
              membership.status === "active",
          ),
      );
      return (row ?? null) as Row | null;
    },
    many: async <Row extends object>(sql: string, params: SqlParameters = []) => {
      if (
        !sql.includes("workspace_memberships") ||
        !sql.includes("memberships.status = 'active'")
      ) {
        throw new Error("Activity lookup must enforce the effective Workspace Membership");
      }
      const issueId = typeof params[0] === "string" ? params[0] : "";
      const workspaceId = typeof params[1] === "string" ? params[1] : "";
      const rows = activities.filter(
        (candidate) =>
          candidate.issue_id === issueId &&
          memberships.some(
            (membership) =>
              membership.actorId === candidate.actor_id &&
              membership.workspaceId === workspaceId &&
              membership.status === "active",
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
  it("excludes foreign and inactive Membership rows from Activity and actor fields", async () => {
    const actors = [actor("actor-a"), actor("actor-b"), actor("actor-suspended")];
    const persistence = persistenceFor(
      [
        activity("activity-a", "actor-a"),
        activity("activity-b", "actor-b"),
        activity("activity-suspended", "actor-suspended"),
      ],
      actors,
      [
        { actorId: "actor-a", workspaceId: "workspace-a", status: "active" },
        { actorId: "actor-b", workspaceId: "workspace-b", status: "active" },
        { actorId: "actor-suspended", workspaceId: "workspace-a", status: "suspended" },
      ],
    );

    await expect(listPostgresActivity(persistence, "issue-1", "workspace-a")).resolves.toEqual([
      activity("activity-a", "actor-a"),
    ]);
    await expect(
      getPostgresActorInWorkspace(persistence, "actor-a", "workspace-a"),
    ).resolves.toEqual(actor("actor-a"));
    await expect(
      getPostgresActorInWorkspace(persistence, "actor-b", "workspace-a"),
    ).resolves.toBeNull();
    await expect(
      getPostgresActorInWorkspace(persistence, "actor-suspended", "workspace-a"),
    ).resolves.toBeNull();
  });
});
