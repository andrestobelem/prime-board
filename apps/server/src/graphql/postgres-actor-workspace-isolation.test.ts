// PRB-605: Actors y Activity respetan la Membership del Workspace en PostgreSQL.
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { newId, now } from "../db/util.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: GraphqlError[];
}

interface ActorResult {
  id: string;
  name: string;
  status: string;
  workspaceRole: string;
  workspaceId: string;
}

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("aislamiento de Actors y Activity en PostgreSQL", () => {
  integration(
    "aplica el Workspace efectivo y la Membership en roots y nested resolvers",
    async () => {
      const harness = await createPostgresHarness({
        url: process.env.PRIME_BOARD_POSTGRES_URL!,
        schemaPrefix: "prb605_actor_scope",
        lockKey: `prb605-actor-scope-${randomUUID()}`,
      });
      const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
        close: false,
      });
      const db = openDatabase(":memory:");
      let stop: (() => void) | undefined;
      try {
        const seeded = await bootstrapPostgres(persistence);
        if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
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
        const app = createApp({ db, config, persistence });
        stop = () => app.server.stop();

        const request = async (
          query: string,
          variables?: Record<string, unknown>,
          token = seeded.adminApiKey!,
          workspaceSelector?: string,
        ): Promise<GraphqlResponse> => {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          };
          if (workspaceSelector) headers["x-workspace-id"] = workspaceSelector;
          const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables }),
          });
          return (await response.json()) as GraphqlResponse;
        };

        const workspaceA = await persistence.one<{ id: string; url_key: string }>(
          "SELECT id, url_key FROM workspace",
        );
        const admin = await persistence.one<{ id: string }>(
          "SELECT id FROM actors WHERE name = 'admin'",
        );
        const team = await persistence.one<{ id: string }>(
          "SELECT id FROM teams ORDER BY created_at, id LIMIT 1",
        );
        if (!workspaceA || !admin || !team) {
          throw new Error("PostgreSQL Actor scope fixture is incomplete");
        }
        const state = await persistence.one<{ id: string }>(
          "SELECT id FROM workflow_states WHERE team_id = $1 ORDER BY position, id LIMIT 1",
          [team.id],
        );
        if (!state) throw new Error("PostgreSQL Actor scope fixture has no workflow state");

        const legacyActors = await request("{ actors { id name workspaceId } }");
        expect(legacyActors.errors).toBeUndefined();
        expect(legacyActors.data?.actors).toEqual([
          { id: admin.id, name: "admin", workspaceId: workspaceA.id },
        ]);

        await persistence.execute("DROP INDEX workspace_singleton_idx");
        await persistence.execute("DROP INDEX actors_name_lower_idx");
        const workspaceBId = newId();
        const timestamp = now();
        await persistence.execute(
          `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
         VALUES ($1, 'PRB-605 Workspace B', 'prb605-b', $2, $2)`,
          [workspaceBId, timestamp],
        );
        await persistence.execute(
          `INSERT INTO workspace_memberships
         (id, workspace_id, actor_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
          [newId(), workspaceBId, admin.id, timestamp],
        );
        const adminKeyId = await persistence.one<{ id: string }>(
          "SELECT id FROM api_keys WHERE actor_id = $1 ORDER BY created_at, id LIMIT 1",
          [admin.id],
        );
        if (!adminKeyId) throw new Error("PostgreSQL Actor scope key fixture is incomplete");
        await persistence.execute(
          `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
         VALUES ($1, $2, 0, $3)`,
          [adminKeyId.id, workspaceBId, timestamp],
        );

        const insertActor = async (name: string): Promise<string> => {
          const id = newId();
          await persistence.execute(
            `INSERT INTO actors (id, name, type, workspace_role, created_at, updated_at)
           VALUES ($1, $2, 'agent', 'member', $3, $3)`,
            [id, name, timestamp],
          );
          return id;
        };
        const actorA = await insertActor("same-name");
        const actorB = await insertActor("same-name");
        const orphan = await insertActor("orphan");
        const suspendedA = await insertActor("suspended-a");

        await persistence.execute(
          "DELETE FROM workspace_memberships WHERE actor_id = $1 AND workspace_id = $2",
          [actorA, workspaceBId],
        );
        await persistence.execute(
          "DELETE FROM workspace_memberships WHERE actor_id = $1 AND workspace_id = $2",
          [actorB, workspaceA.id],
        );
        await persistence.execute("DELETE FROM workspace_memberships WHERE actor_id = $1", [
          orphan,
        ]);
        await persistence.execute(
          `DELETE FROM workspace_memberships WHERE actor_id = $1 AND workspace_id = $2`,
          [suspendedA, workspaceBId],
        );
        await persistence.execute(
          `UPDATE workspace_memberships SET status = 'suspended'
         WHERE actor_id = $1 AND workspace_id = $2`,
          [suspendedA, workspaceA.id],
        );

        const aOnlyToken = generateApiKey();
        const aOnlyKeyId = newId();
        await persistence.execute(
          `INSERT INTO api_keys (id, actor_id, name, hash, created_at)
         VALUES ($1, $2, 'PRB-605 A-only key', $3, $4)`,
          [aOnlyKeyId, admin.id, hashApiKey(aOnlyToken), timestamp],
        );
        await persistence.execute(
          `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
         VALUES ($1, $2, 1, $3)`,
          [aOnlyKeyId, workspaceA.id, timestamp],
        );

        const actorsIn = async (workspaceSelector: string, token = seeded.adminApiKey!) => {
          const result = await request(
            `{ actors { id name status workspaceRole workspaceId } }`,
            undefined,
            token,
            workspaceSelector,
          );
          expect(result.errors).toBeUndefined();
          return result.data?.actors as ActorResult[];
        };

        const actorsA = await actorsIn(workspaceA.id);
        expect(actorsA.map((actor) => actor.id)).toEqual(
          expect.arrayContaining([admin.id, actorA, suspendedA]),
        );
        expect(actorsA.map((actor) => actor.id)).not.toContain(actorB);
        expect(actorsA.map((actor) => actor.id)).not.toContain(orphan);
        expect(actorsA.find((actor) => actor.id === actorA)?.name).toBe("same-name");
        expect(actorsA.find((actor) => actor.id === suspendedA)).toMatchObject({
          status: "SUSPENDED",
          workspaceId: workspaceA.id,
        });
        expect(actorsA.find((actor) => actor.id === admin.id)).toMatchObject({
          workspaceRole: "ADMIN",
          workspaceId: workspaceA.id,
        });

        const actorsB = await actorsIn(workspaceBId);
        expect(actorsB.map((actor) => actor.id)).toEqual(
          expect.arrayContaining([admin.id, actorB]),
        );
        expect(actorsB.map((actor) => actor.id)).not.toContain(actorA);
        expect(actorsB.map((actor) => actor.id)).not.toContain(suspendedA);
        expect(actorsB.map((actor) => actor.id)).not.toContain(orphan);
        expect(actorsB.find((actor) => actor.id === actorB)?.name).toBe("same-name");
        expect(actorsB.find((actor) => actor.id === admin.id)).toMatchObject({
          workspaceRole: "MEMBER",
          workspaceId: workspaceBId,
        });

        const issueId = newId();
        await persistence.execute(
          `INSERT INTO issues
         (id, team_id, number, title, description, state_id, priority, assignee_id,
          parent_id, project_id, creator_id, sort_order, created_at, updated_at,
          archived_at, milestone_id, cycle_id)
         VALUES ($1, $2, 1, 'PRB-605 Activity scope', NULL, $3, 0, NULL, NULL, NULL,
                 $4, 0, $5, $5, NULL, NULL, NULL)`,
          [issueId, team.id, state.id, admin.id, timestamp],
        );
        const insertActivity = async (actorId: string, type: string) => {
          await persistence.execute(
            `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
           VALUES ($1, $2, $3, $4, '{}', $5)`,
            [newId(), issueId, actorId, type, timestamp],
          );
        };
        await insertActivity(actorA, "a_activity");
        await insertActivity(actorB, "b_activity");
        await insertActivity(admin.id, "shared_activity");
        await insertActivity(orphan, "orphan_activity");

        const activityIn = async (workspaceSelector: string) => {
          const result = await request(
            `query($id: ID!) {
             issue(id: $id) {
               activity { type actor { id name status workspaceId } }
             }
           }`,
            { id: issueId },
            seeded.adminApiKey!,
            workspaceSelector,
          );
          expect(result.errors).toBeUndefined();
          return result.data?.issue as {
            activity: Array<{ type: string; actor: ActorResult | null }>;
          };
        };

        const activityA = await activityIn(workspaceA.id);
        expect(activityA.activity).toEqual(
          expect.arrayContaining([
            {
              type: "a_activity",
              actor: expect.objectContaining({
                id: actorA,
                name: "same-name",
                status: "SUSPENDED",
                workspaceId: workspaceA.id,
              }),
            },
            {
              type: "shared_activity",
              actor: expect.objectContaining({ id: admin.id, workspaceId: workspaceA.id }),
            },
          ]),
        );
        expect(activityA.activity.map((activity) => activity.type)).not.toContain("b_activity");
        expect(activityA.activity.map((activity) => activity.type)).not.toContain(
          "orphan_activity",
        );

        const activityB = await activityIn(workspaceBId);
        expect(activityB.activity).toEqual(
          expect.arrayContaining([
            {
              type: "b_activity",
              actor: expect.objectContaining({
                id: actorB,
                name: "same-name",
                status: "ACTIVE",
                workspaceId: workspaceBId,
              }),
            },
            {
              type: "shared_activity",
              actor: expect.objectContaining({ id: admin.id, workspaceId: workspaceBId }),
            },
          ]),
        );
        expect(activityB.activity.map((activity) => activity.type)).not.toContain("a_activity");
        expect(activityB.activity.map((activity) => activity.type)).not.toContain(
          "orphan_activity",
        );

        const rejectedSelector = await request(
          "{ actors { id } }",
          undefined,
          aOnlyToken,
          workspaceBId,
        );
        expect(rejectedSelector.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
        const forgedLastUsed = await persistence.one<{ last_used_at: string | null }>(
          "SELECT last_used_at FROM api_keys WHERE id = $1",
          [aOnlyKeyId],
        );
        expect(forgedLastUsed?.last_used_at).toBeNull();

        const unknownSelector = await request(
          "{ actors { id } }",
          undefined,
          seeded.adminApiKey,
          "workspace-not-granted",
        );
        expect(unknownSelector.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
      } finally {
        stop?.();
        db.close();
        await persistence.close();
        await harness.close();
      }
    },
  );
});
