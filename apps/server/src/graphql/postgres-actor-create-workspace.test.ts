// PRB-667: actorCreate asigna el Actor solo al Workspace efectivo en PostgreSQL.
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
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

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
}

interface Actor {
  id: string;
  name: string;
  workspaceId: string;
}

interface ActorCreateData {
  actorCreate: {
    success: boolean;
    actor: Actor;
  };
}

interface ActorsData {
  actors: Actor[];
}

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL actorCreate Workspace scope", () => {
  integration(
    "creates the Actor only in the effective Workspace and isolates the actors root",
    async () => {
      const harness = await createPostgresHarness({
        url: process.env.PRIME_BOARD_POSTGRES_URL!,
        schemaPrefix: "prb667_actor_create",
        lockKey: `prb667-actor-create-${randomUUID()}`,
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
        } satisfies Config;
        const app = createApp({ db, config, persistence });
        stop = () => app.server.stop();

        const request = async <T>(
          query: string,
          token = seeded.adminApiKey!,
          workspaceSelector?: string,
        ): Promise<GraphqlResponse<T>> => {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          };
          if (workspaceSelector) headers["x-workspace-id"] = workspaceSelector;
          const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
            method: "POST",
            headers,
            body: JSON.stringify({ query }),
          });
          return (await response.json()) as GraphqlResponse<T>;
        };

        const workspaceA = await persistence.one<{ id: string }>(
          "SELECT id FROM workspace ORDER BY created_at, id LIMIT 1",
        );
        const admin = await persistence.one<{ id: string }>(
          "SELECT id FROM actors WHERE name = 'admin'",
        );
        if (!workspaceA || !admin) throw new Error("PostgreSQL Actor fixture is incomplete");

        await persistence.execute("DROP INDEX workspace_singleton_idx");
        const workspaceBId = newId();
        const timestamp = now();
        await persistence.execute(
          `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
           VALUES ($1, 'PRB-667 Workspace B', 'prb667-b', $2, $2)`,
          [workspaceBId, timestamp],
        );
        await persistence.execute(
          `INSERT INTO workspace_memberships
           (id, workspace_id, actor_id, role, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'admin', 'active', $4, $4)`,
          [newId(), workspaceBId, admin.id, timestamp],
        );
        const adminKey = await persistence.one<{ id: string }>(
          "SELECT id FROM api_keys WHERE actor_id = $1 ORDER BY created_at, id LIMIT 1",
          [admin.id],
        );
        if (!adminKey) throw new Error("PostgreSQL Actor key fixture is incomplete");
        await persistence.execute(
          `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
           VALUES ($1, $2, 0, $3)`,
          [adminKey.id, workspaceBId, timestamp],
        );

        const created = await request<ActorCreateData>(
          `mutation {
             actorCreate(input: { name: "PRB-667 scoped actor", type: AGENT }) {
               success
               actor { id name workspaceId }
             }
           }`,
          seeded.adminApiKey!,
          workspaceBId,
        );
        expect(created.errors).toBeUndefined();
        expect(created.data?.actorCreate.success).toBe(true);
        const actor = created.data?.actorCreate.actor;
        if (!actor) throw new Error("PostgreSQL actorCreate did not return an Actor");
        expect(actor).toMatchObject({ name: "PRB-667 scoped actor", workspaceId: workspaceBId });

        const memberships = await persistence.many<{
          workspace_id: string;
          role: string;
          status: string;
        }>(
          `SELECT workspace_id, role, status
           FROM workspace_memberships
           WHERE actor_id = $1
           ORDER BY workspace_id`,
          [actor.id],
        );
        expect(memberships).toEqual([
          { workspace_id: workspaceBId, role: "member", status: "active" },
        ]);

        const actorsA = await request<ActorsData>(
          "{ actors { id name workspaceId } }",
          seeded.adminApiKey!,
          workspaceA.id,
        );
        expect(actorsA.errors).toBeUndefined();
        expect(actorsA.data?.actors.map((item) => item.id)).not.toContain(actor.id);

        const actorsB = await request<ActorsData>(
          "{ actors { id name workspaceId } }",
          seeded.adminApiKey!,
          workspaceBId,
        );
        expect(actorsB.errors).toBeUndefined();
        expect(actorsB.data?.actors).toContainEqual(actor);
      } finally {
        stop?.();
        db.close();
        await persistence.close();
        await harness.close();
      }
    },
  );
});
