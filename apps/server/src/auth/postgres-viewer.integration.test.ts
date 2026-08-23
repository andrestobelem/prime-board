import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateApiKey, hashApiKey } from "./keys.ts";
import { resolvePostgresAuth } from "./postgres-viewer.ts";
import { now, newId } from "../db/util.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL authentication integration", () => {
  integration("requires key, grant, selected Workspace and active Membership", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb513_auth",
      lockKey: `prb513-auth-${randomUUID()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    try {
      const seeded = await bootstrapPostgres(persistence);
      if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
      const workspace = await persistence.one<{ id: string; url_key: string }>(
        "SELECT id, url_key FROM workspace",
      );
      const admin = await persistence.one<{ id: string }>(
        "SELECT id FROM actors WHERE name = 'admin'",
      );
      if (!workspace || !admin) throw new Error("PostgreSQL auth fixture is incomplete");

      // Los valores globales del Actor quedan obsoletos. La Membership es la autoridad.
      await persistence.execute(
        "UPDATE actors SET workspace_role = 'member', status = 'suspended' WHERE id = $1",
        [admin.id],
      );
      const allowed = await resolvePostgresAuth(
        persistence,
        `Bearer ${seeded.adminApiKey}`,
        workspace.url_key,
      );
      expect(allowed).toMatchObject({
        workspaceId: workspace.id,
        workspaceRole: "admin",
        workspaceStatus: "active",
        actor: { workspace_role: "admin", status: "active" },
      });

      await persistence.execute(
        "UPDATE workspace_memberships SET status = 'suspended' WHERE workspace_id = $1 AND actor_id = $2",
        [workspace.id, admin.id],
      );
      await expect(
        resolvePostgresAuth(persistence, `Bearer ${seeded.adminApiKey}`, workspace.url_key),
      ).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });

      await persistence.execute(
        "UPDATE workspace_memberships SET status = 'active' WHERE workspace_id = $1 AND actor_id = $2",
        [workspace.id, admin.id],
      );
      await expect(
        resolvePostgresAuth(persistence, `Bearer ${seeded.adminApiKey}`, "not-granted"),
      ).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });

      const ungrantedKey = generateApiKey();
      const ungrantedKeyId = newId();
      await persistence.execute(
        `INSERT INTO api_keys (id, actor_id, name, hash, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [ungrantedKeyId, admin.id, "PRB-513 ungranted key", hashApiKey(ungrantedKey), now()],
      );
      await persistence.execute("DELETE FROM api_key_workspaces WHERE api_key_id = $1", [
        ungrantedKeyId,
      ]);
      await expect(
        resolvePostgresAuth(persistence, `Bearer ${ungrantedKey}`, workspace.url_key),
      ).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
    } finally {
      await persistence.close();
      await harness.close();
    }
  });
});
