// PRB-680: Issue.comments must preserve the effective Workspace in PostgreSQL.
import { afterEach, describe, expect, it } from "bun:test";
import { hashApiKey } from "../auth/keys.ts";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { newId, now } from "../db/util.ts";
import type { Config } from "../config.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

type GraphqlResult = {
  data?: {
    issue: {
      id: string;
      comments: Array<{
        body: string;
        actor: { id: string; name: string; workspaceId: string } | null;
        issue: { id: string } | null;
      }>;
    } | null;
  };
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

describe("PostgreSQL Issue.comments Workspace isolation", () => {
  let close: (() => Promise<void>) | undefined;
  let stop: (() => void) | undefined;

  afterEach(async () => {
    stop?.();
    stop = undefined;
    await close?.();
    close = undefined;
  });

  integration("returns only comments and Actors from the effective Workspace", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb680_comments_scope",
      lockKey: `prb680-comments-${newId()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    const db = openDatabase(":memory:");
    const config = {
      port: 0,
      host: "127.0.0.1",
      authMode: "api-key",
      dbPath: ":memory:",
      postgresUrl: process.env.PRIME_BOARD_POSTGRES_URL,
      persistenceBackend: "postgres",
      dev: false,
      webDist: "/tmp/prime-board-no-web",
      repoRoot: null,
      bootstrap: resolveBootstrapIdentity({}),
    } as Config;
    const seeded = await bootstrapPostgres(persistence);
    if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
    const { createApp } = await import("../server.ts");
    const app = createApp({ db, config, persistence });
    stop = () => app.server.stop();
    close = async () => {
      db.close();
      await persistence.close();
      await harness.close();
    };

    const request = async (
      query: string,
      variables: Record<string, unknown>,
      workspaceId: string,
    ) => {
      const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${seeded.adminApiKey}`,
          "x-workspace-id": workspaceId,
        },
        body: JSON.stringify({ query, variables }),
      });
      return (await response.json()) as GraphqlResult;
    };

    const workspaceA = await persistence.one<{ id: string }>("SELECT id FROM workspace");
    const admin = await persistence.one<{ id: string }>(
      "SELECT id FROM actors WHERE name = 'admin'",
    );
    const teamA = await persistence.one<{ id: string }>(
      "SELECT id FROM teams ORDER BY created_at, id LIMIT 1",
    );
    if (!workspaceA || !admin || !teamA) throw new Error("PostgreSQL fixture is incomplete");

    const workspaceB = newId();
    const timestamp = now();
    await persistence.execute(
      `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
       VALUES ($1, 'PRB-680 Workspace B', 'prb680-b', $2, $2)`,
      [workspaceB, timestamp],
    );
    await persistence.execute(
      `INSERT INTO workspace_memberships
       (id, workspace_id, actor_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
      [newId(), workspaceB, admin.id, timestamp],
    );
    const key = await persistence.one<{ id: string }>("SELECT id FROM api_keys WHERE hash = $1", [
      hashApiKey(seeded.adminApiKey!),
    ]);
    if (!key) throw new Error("PostgreSQL bootstrap key was not persisted");
    await persistence.execute(
      `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
       VALUES ($1, $2, 0, $3)`,
      [key.id, workspaceB, timestamp],
    );

    const actorA = newId();
    const actorB = newId();
    for (const [actorId, name, workspaceId] of [
      [actorA, "PRB-680 actor A", workspaceA.id],
      [actorB, "PRB-680 actor B", workspaceB],
    ] as const) {
      await persistence.execute(
        `INSERT INTO actors (id, name, type, workspace_role, created_at, updated_at)
         VALUES ($1, $2, 'agent', 'member', $3, $3)`,
        [actorId, name, timestamp],
      );
      await persistence.execute(
        `INSERT INTO workspace_memberships
         (id, workspace_id, actor_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
        [newId(), workspaceId, actorId, timestamp],
      );
    }

    const createScopedIssue = async (workspaceId: string, teamKey: string, actorId: string) => {
      const teamId = newId();
      const stateId = newId();
      const issueId = newId();
      await persistence.execute(
        `INSERT INTO teams
         (id, workspace_id, name, key, description, created_at, updated_at, access_policy)
         VALUES ($1, $2, $3, $4, 'PRB-680 fixture', $5, $5, 'workspace_members')`,
        [teamId, workspaceId, `PRB-680 ${teamKey}`, teamKey, timestamp],
      );
      await persistence.execute(
        `INSERT INTO team_memberships
         (id, workspace_id, team_id, actor_id, role, created_at)
         VALUES ($1, $2, $3, $4, 'owner', $5)`,
        [newId(), workspaceId, teamId, actorId, timestamp],
      );
      await persistence.execute(
        `INSERT INTO workflow_states
         (id, workspace_id, team_id, name, type, color, position, created_at, updated_at)
         VALUES ($1, $2, $3, 'Todo', 'unstarted', '#888888', 0, $4, $4)`,
        [stateId, workspaceId, teamId, timestamp],
      );
      await persistence.execute("UPDATE teams SET default_state_id = $1 WHERE id = $2", [
        stateId,
        teamId,
      ]);
      await persistence.execute(
        `INSERT INTO issues
         (id, workspace_id, team_id, number, title, description, state_id, priority,
          assignee_id, parent_id, project_id, creator_id, sort_order, created_at, updated_at,
          archived_at, milestone_id, cycle_id)
         VALUES ($1, $2, $3, 1, $4, NULL, $5, 0, NULL, NULL, NULL, $6, 0, $7, $7, NULL, NULL, NULL)`,
        [issueId, workspaceId, teamId, `PRB-680 ${teamKey} issue`, stateId, actorId, timestamp],
      );
      return issueId;
    };

    const issueA = await createScopedIssue(workspaceA.id, "PRB", actorA);
    const issueB = await createScopedIssue(workspaceB, "PRB", actorB);
    await persistence.execute(
      `INSERT INTO comments
       (id, workspace_id, issue_id, actor_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), workspaceA.id, issueA, actorA, "comment A", timestamp],
    );
    await persistence.execute(
      `INSERT INTO comments
       (id, workspace_id, issue_id, actor_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), workspaceB, issueB, actorB, "comment B", timestamp],
    );

    const query = `query($id: ID!) {
      issue(id: $id) {
        id
        comments { body actor { id name workspaceId } issue { id } }
      }
    }`;
    const visibleA = await request(query, { id: issueA }, workspaceA.id);
    expect(visibleA.errors).toBeUndefined();
    expect(visibleA.data?.issue).toEqual({
      id: issueA,
      comments: [
        {
          body: "comment A",
          actor: { id: actorA, name: "PRB-680 actor A", workspaceId: workspaceA.id },
          issue: { id: issueA },
        },
      ],
    });

    const hiddenBFromA = await request(query, { id: issueB }, workspaceA.id);
    expect(hiddenBFromA.errors).toBeUndefined();
    expect(hiddenBFromA.data?.issue).toBeNull();

    const visibleB = await request(query, { id: issueB }, workspaceB);
    expect(visibleB.errors).toBeUndefined();
    expect(visibleB.data?.issue).toEqual({
      id: issueB,
      comments: [
        {
          body: "comment B",
          actor: { id: actorB, name: "PRB-680 actor B", workspaceId: workspaceB },
          issue: { id: issueB },
        },
      ],
    });
  });
});
