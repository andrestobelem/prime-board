// PRB-665: Initiative.resources debe validar igual en PostgreSQL y SQLite.
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

type GraphqlError = { message: string; extensions?: { code?: string } };
type GraphqlResponse = {
  data?: Record<string, any>;
  errors?: GraphqlError[];
};

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL Initiative resources", () => {
  integration("matches SQLite validation for create and update", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb665_initiative_resources",
      lockKey: `prb665-initiative-resources-${randomUUID()}`,
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
      ): Promise<GraphqlResponse> => {
        const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${seeded.adminApiKey}`,
          },
          body: JSON.stringify({ query, variables }),
        });
        return (await response.json()) as GraphqlResponse;
      };

      const invalidResources = [{ invalid: true }, "not-a-list"];
      for (const [index, resources] of invalidResources.entries()) {
        const result = await request(
          `mutation($resources: JSON) {
            initiativeCreate(input: { name: "PRB-665 invalid ${index}", resources: $resources }) {
              success
            }
          }`,
          { resources },
        );
        expect(result.errors?.[0]).toMatchObject({
          message: "Initiative resources must be a list",
          extensions: { code: "VALIDATION_FAILED" },
        });
      }

      const nullResources = await request(
        `mutation { initiativeCreate(input: { name: "PRB-665 null" , resources: null }) {
          initiative { resources }
        } }`,
      );
      expect(nullResources.errors).toBeUndefined();
      expect(nullResources.data!.initiativeCreate.initiative.resources).toEqual([]);

      const omittedResources = await request(
        `mutation { initiativeCreate(input: { name: "PRB-665 omitted" }) {
          initiative { resources }
        } }`,
      );
      expect(omittedResources.errors).toBeUndefined();
      expect(omittedResources.data!.initiativeCreate.initiative.resources).toEqual([]);

      const created = await request(
        `mutation($resources: JSON) {
          initiativeCreate(input: { name: "PRB-665 valid", resources: $resources }) {
            initiative { id resources }
          }
        }`,
        { resources: [{ name: "before" }] },
      );
      expect(created.errors).toBeUndefined();
      const initiative = created.data!.initiativeCreate.initiative as {
        id: string;
        resources: unknown[];
      };
      expect(initiative.resources).toEqual([{ name: "before" }]);

      const omitted = await request(
        `mutation($id: ID!) {
          initiativeUpdate(id: $id, input: { description: "omitted resources" }) {
            initiative { resources }
          }
        }`,
        { id: initiative.id },
      );
      expect(omitted.errors).toBeUndefined();
      expect(omitted.data!.initiativeUpdate.initiative.resources).toEqual([{ name: "before" }]);

      const cleared = await request(
        `mutation($id: ID!, $resources: JSON) {
          initiativeUpdate(id: $id, input: { resources: $resources }) {
            initiative { resources }
          }
        }`,
        { id: initiative.id, resources: null },
      );
      expect(cleared.errors).toBeUndefined();
      expect(cleared.data!.initiativeUpdate.initiative.resources).toEqual([]);

      const updated = await request(
        `mutation($id: ID!, $resources: JSON) {
          initiativeUpdate(id: $id, input: { resources: $resources }) {
            initiative { resources }
          }
        }`,
        { id: initiative.id, resources: [{ name: "after" }, "metadata"] },
      );
      expect(updated.errors).toBeUndefined();
      expect(updated.data!.initiativeUpdate.initiative.resources).toEqual([
        { name: "after" },
        "metadata",
      ]);

      for (const resources of invalidResources) {
        const result = await request(
          `mutation($id: ID!, $resources: JSON) {
            initiativeUpdate(id: $id, input: { resources: $resources }) { success }
          }`,
          { id: initiative.id, resources },
        );
        expect(result.errors?.[0]).toMatchObject({
          message: "Initiative resources must be a list",
          extensions: { code: "VALIDATION_FAILED" },
        });
      }

      const afterInvalid = await request(`query($id: ID!) { initiative(id: $id) { resources } }`, {
        id: initiative.id,
      });
      expect(afterInvalid.errors).toBeUndefined();
      expect(afterInvalid.data!.initiative.resources).toEqual([{ name: "after" }, "metadata"]);
    } finally {
      stop?.();
      db.close();
      await persistence.close();
      await harness.close();
    }
  });
});
