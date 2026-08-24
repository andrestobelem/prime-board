// PRB-552: aislamiento de API keys PostgreSQL por grant y Membership efectiva.
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createApp } from "../server.ts";
import { newId, now } from "../db/util.ts";
import type { Config } from "../config.ts";

type GraphqlError = { message: string; extensions?: { code?: string } };
type GraphqlResponse = {
  data?: Record<string, unknown>;
  errors?: GraphqlError[];
};

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL API key Workspace isolation", () => {
  integration(
    "requires the effective grant and Membership for list/create/rotate/delete",
    async () => {
      const harness = await createPostgresHarness({
        url: process.env.PRIME_BOARD_POSTGRES_URL!,
        schemaPrefix: "prb552_api_keys",
        lockKey: `prb552-api-keys-${randomUUID()}`,
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
          workspaceId?: string,
        ): Promise<GraphqlResponse> => {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          };
          if (workspaceId) headers["x-workspace-id"] = workspaceId;
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
        const teamA = await persistence.one<{ id: string }>(
          "SELECT id FROM teams ORDER BY created_at, id LIMIT 1",
        );
        if (!workspaceA || !admin || !teamA)
          throw new Error("PostgreSQL API key fixture is incomplete");

        const workerCreated = await request(
          `mutation { actorCreate(input: { name: "PRB-552 worker", type: AGENT }) { actor { id } } }`,
        );
        expect(workerCreated.errors).toBeUndefined();
        const workerId = (workerCreated.data!.actorCreate as { actor: { id: string } }).actor.id;

        const created = await request(
          `mutation($actorId: ID!, $teamId: ID!) {
             apiKeyCreate(input: { actorId: $actorId, name: "PRB-552 rotatable", teamIds: [$teamId] }) {
               apiKey { id teamIds }
               key
             }
           }`,
          { actorId: workerId, teamId: teamA.id },
        );
        expect(created.errors).toBeUndefined();
        const createdKey = created.data!.apiKeyCreate as {
          apiKey: { id: string; teamIds: string[] };
          key: string;
        };
        expect(createdKey.apiKey.teamIds).toEqual([teamA.id]);
        const oldKey = createdKey.key;

        const listed = await request(`{ actors { id apiKeys { id name teamIds } } }`);
        expect(listed.errors).toBeUndefined();
        const listedActors = listed.data!.actors as Array<{
          id: string;
          apiKeys: Array<{ id: string; name: string; teamIds: string[] }>;
        }>;
        expect(listedActors.find((actor) => actor.id === workerId)?.apiKeys).toEqual([
          { id: createdKey.apiKey.id, name: "PRB-552 rotatable", teamIds: [teamA.id] },
        ]);
        expect(JSON.stringify(listed.data)).not.toContain("hash");

        const rotated = await request(
          `mutation($id: ID!) {
             apiKeyRotate(id: $id, input: { name: "PRB-552 rotated" }) {
               apiKey { id rotatedFromId teamIds }
               key
             }
           }`,
          { id: createdKey.apiKey.id },
          oldKey,
        );
        expect(rotated.errors).toBeUndefined();
        const rotatedKey = rotated.data!.apiKeyRotate as {
          apiKey: { id: string; rotatedFromId: string; teamIds: string[] };
          key: string;
        };
        expect(rotatedKey.apiKey.rotatedFromId).toBe(createdKey.apiKey.id);
        expect(rotatedKey.apiKey.teamIds).toEqual([teamA.id]);
        const oldRejected = await request("{ viewer { id } }", undefined, oldKey);
        expect(oldRejected.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

        const deleted = await request(
          `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`,
          { id: rotatedKey.apiKey.id },
          rotatedKey.key,
        );
        expect(deleted.errors).toBeUndefined();
        expect((deleted.data!.apiKeyDelete as { success: boolean }).success).toBe(true);
        const deletedRejected = await request("{ viewer { id } }", undefined, rotatedKey.key);
        expect(deletedRejected.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

        const teamBResult = await request(
          `mutation { teamCreate(input: { key: "SEC", name: "PRB-552 other Team" }) { team { id } } }`,
        );
        expect(teamBResult.errors).toBeUndefined();
        const teamB = (teamBResult.data!.teamCreate as { team: { id: string } }).team.id;
        const limitedResult = await request(
          `mutation($actorId: ID!, $teamId: ID!) {
             apiKeyCreate(input: { actorId: $actorId, name: "PRB-552 limited", teamIds: [$teamId] }) {
               apiKey { id teamIds }
               key
             }
           }`,
          { actorId: workerId, teamId: teamA.id },
        );
        expect(limitedResult.errors).toBeUndefined();
        const limited = limitedResult.data!.apiKeyCreate as {
          apiKey: { id: string; teamIds: string[] };
          key: string;
        };
        const crossed = await request(
          `mutation($id: ID!, $teamId: ID!) {
             apiKeyRotate(id: $id, input: { teamIds: [$teamId] }) { apiKey { id } }
           }`,
          { id: limited.apiKey.id, teamId: teamB },
          limited.key,
        );
        expect(crossed.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
        const limitedState = await persistence.one<{ revoked_at: string | null }>(
          "SELECT revoked_at FROM api_keys WHERE id = $1",
          [limited.apiKey.id],
        );
        expect(limitedState?.revoked_at).toBeNull();

        // PRB-513 grants a key to the Workspace explicitly. The legacy
        // trigger keeps its implicit grant only for a singleton; the route
        // below must create and rotate keys with an explicit Workspace.
        await persistence.execute("DROP INDEX workspace_singleton_idx");
        const workspaceBId = newId();
        const timestamp = now();
        await persistence.execute(
          `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
           VALUES ($1, 'PRB-552 Workspace B', 'prb552-b', $2, $2)`,
          [workspaceBId, timestamp],
        );
        await persistence.execute(
          `INSERT INTO workspace_memberships
           (id, workspace_id, actor_id, role, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'admin', 'active', $4, $4)`,
          [newId(), workspaceBId, admin.id, timestamp],
        );
        await persistence.execute(
          `INSERT INTO workspace_memberships
           (id, workspace_id, actor_id, role, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'member', 'suspended', $4, $4)`,
          [newId(), workspaceBId, workerId, timestamp],
        );
        const adminKey = await persistence.one<{ id: string }>(
          "SELECT id FROM api_keys WHERE actor_id = $1 ORDER BY created_at, id LIMIT 1",
          [admin.id],
        );
        if (!adminKey) throw new Error("PostgreSQL admin key fixture is incomplete");
        await persistence.execute(
          `INSERT INTO api_key_workspaces
           (api_key_id, workspace_id, is_default, created_at)
           VALUES ($1, $2, 0, $3)`,
          [adminKey.id, workspaceBId, timestamp],
        );
        // The limit belongs to B but the key has no B grant. PostgreSQL must
        // fail closed instead of reusing it while the key is effective in A.
        await persistence.execute(
          "UPDATE api_key_team_limits SET workspace_id = $2 WHERE api_key_id = $1",
          [limited.apiKey.id, workspaceBId],
        );
        const orphanAuth = await request(
          "{ viewer { id } }",
          undefined,
          limited.key,
          workspaceA.id,
        );
        expect(orphanAuth.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
        const orphanListed = await request(
          `{ actors { id apiKeys { id } } }`,
          undefined,
          seeded.adminApiKey,
          workspaceA.id,
        );
        const orphanWorkerKeys = (
          orphanListed.data!.actors as Array<{
            id: string;
            apiKeys: Array<{ id: string }>;
          }>
        ).find((actor) => actor.id === workerId)?.apiKeys;
        expect(orphanWorkerKeys).toEqual([]);

        const bWorkerCreated = await request(
          `mutation { actorCreate(input: { name: "PRB-552 B worker", type: AGENT }) { actor { id } } }`,
          undefined,
          seeded.adminApiKey,
          workspaceBId,
        );
        expect(bWorkerCreated.errors).toBeUndefined();
        const bWorkerId = (bWorkerCreated.data!.actorCreate as { actor: { id: string } }).actor.id;
        const bKeyCreated = await request(
          `mutation($actorId: ID!, $teamId: ID!) {
             apiKeyCreate(input: { actorId: $actorId, name: "PRB-552 B key", teamIds: [$teamId] }) {
               apiKey { id teamIds }
               key
             }
           }`,
          { actorId: bWorkerId, teamId: teamA.id },
          seeded.adminApiKey,
          workspaceBId,
        );
        expect(bKeyCreated.errors).toBeUndefined();
        const bKey = bKeyCreated.data!.apiKeyCreate as {
          apiKey: { id: string; teamIds: string[] };
          key: string;
        };
        expect(bKey.apiKey.teamIds).toEqual([teamA.id]);
        const bListed = await request(
          `{ actors { id apiKeys { id teamIds } } }`,
          undefined,
          seeded.adminApiKey,
          workspaceBId,
        );
        const bWorkerKeys = (
          bListed.data!.actors as Array<{
            id: string;
            apiKeys: Array<{ id: string; teamIds: string[] }>;
          }>
        ).find((actor) => actor.id === bWorkerId)?.apiKeys;
        expect(bWorkerKeys).toEqual([{ id: bKey.apiKey.id, teamIds: [teamA.id] }]);
        const bRotated = await request(
          `mutation($id: ID!) {
             apiKeyRotate(id: $id, input: { name: "PRB-552 B rotated" }) {
               apiKey { id rotatedFromId teamIds }
               key
             }
           }`,
          { id: bKey.apiKey.id },
          bKey.key,
          workspaceBId,
        );
        expect(bRotated.errors).toBeUndefined();
        const bRotatedKey = bRotated.data!.apiKeyRotate as {
          apiKey: { id: string; rotatedFromId: string; teamIds: string[] };
          key: string;
        };
        expect(bRotatedKey.apiKey.rotatedFromId).toBe(bKey.apiKey.id);
        expect(bRotatedKey.apiKey.teamIds).toEqual([teamA.id]);
        const bDeleted = await request(
          `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`,
          { id: bRotatedKey.apiKey.id },
          bRotatedKey.key,
          workspaceBId,
        );
        expect(bDeleted.errors).toBeUndefined();
        expect((bDeleted.data!.apiKeyDelete as { success: boolean }).success).toBe(true);

        const notListedWithoutGrant = await request(
          `{ actors { id apiKeys { id } } }`,
          undefined,
          seeded.adminApiKey,
          workspaceBId,
        );
        expect(notListedWithoutGrant.errors).toBeUndefined();
        const bActors = notListedWithoutGrant.data!.actors as Array<{
          id: string;
          apiKeys: Array<{ id: string }>;
        }>;
        expect(bActors.find((actor) => actor.id === workerId)?.apiKeys).toEqual([]);

        const limitsWithoutGrant = await persistence.one<{ team_id: string }>(
          `SELECT limits.team_id
           FROM api_key_team_limits AS limits
           JOIN api_key_workspaces AS grants
             ON grants.api_key_id = limits.api_key_id AND grants.workspace_id = $2
           WHERE limits.api_key_id = $1`,
          [limited.apiKey.id, workspaceBId],
        );
        expect(limitsWithoutGrant).toBeNull();

        const createSuspended = await request(
          `mutation($actorId: ID!) {
             apiKeyCreate(input: { actorId: $actorId, name: "PRB-552 denied" }) { key }
           }`,
          { actorId: workerId },
          seeded.adminApiKey,
          workspaceBId,
        );
        expect(createSuspended.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

        const rotateWithoutGrant = await request(
          `mutation($id: ID!) { apiKeyRotate(id: $id, input: { name: "PRB-552 denied" }) { key } }`,
          { id: limited.apiKey.id },
          seeded.adminApiKey,
          workspaceBId,
        );
        expect(rotateWithoutGrant.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
        const deleteWithoutGrant = await request(
          `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`,
          { id: limited.apiKey.id },
          seeded.adminApiKey,
          workspaceBId,
        );
        expect(deleteWithoutGrant.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
        const grantStillExists = await persistence.one<{ workspace_id: string }>(
          "SELECT workspace_id FROM api_key_workspaces WHERE api_key_id = $1 AND workspace_id = $2",
          [limited.apiKey.id, workspaceA.id],
        );
        expect(grantStillExists?.workspace_id).toBe(workspaceA.id);
      } finally {
        stop?.();
        db.close();
        await persistence.close();
        await harness.close();
      }
    },
  );
});
