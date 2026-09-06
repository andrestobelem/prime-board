import { describe, expect, it } from "bun:test";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { openDatabase } from "../db/database.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL project dependency GraphQL contract", () => {
  integration("matches SQLite success, validation and delete behavior", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb608_project_dependencies",
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
    const seeded = await bootstrapPostgres(persistence, config.bootstrap);
    const workspace = await persistence.one<{ id: string }>("SELECT id FROM workspace");
    const team = await persistence.one<{ id: string }>("SELECT id FROM teams ORDER BY key LIMIT 1");
    if (!workspace || !team || !seeded.adminApiKey)
      throw new Error("PostgreSQL fixture is incomplete");

    const { server } = createApp({ db, config, persistence });
    const request = async (query: string, variables: Record<string, unknown> = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${seeded.adminApiKey}`,
        },
        body: JSON.stringify({ query, variables }),
      });
      return (await response.json()) as {
        data?: Record<string, any>;
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
      };
    };

    try {
      const source = await request(
        `mutation($teamId: ID!) { projectCreate(input: { name: "Dependency source", teamIds: [$teamId] }) { project { id } } }`,
        { teamId: team.id },
      );
      const sourceId = source.data!.projectCreate.project.id as string;
      const target = await request(
        `mutation($teamId: ID!) { projectCreate(input: { name: "Dependency target", teamIds: [$teamId] }) { project { id } } }`,
        { teamId: team.id },
      );
      const targetId = target.data!.projectCreate.project.id as string;

      const related = await request(
        `mutation($source: ID!, $target: ID!) {
          projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target, type: RELATED }) {
            success dependency { id project { id } dependsOnProject { id } type createdAt }
          }
        }`,
        { source: sourceId, target: targetId },
      );
      expect(related.errors).toBeUndefined();
      expect(related.data!.projectDependencyCreate).toMatchObject({
        success: true,
        dependency: {
          project: { id: sourceId },
          dependsOnProject: { id: targetId },
          type: "RELATED",
        },
      });

      const self = await request(
        `mutation($source: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $source }) { success } }`,
        { source: sourceId },
      );
      expect(self.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

      const missing = await request(
        `mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target }) { success } }`,
        { source: sourceId, target: "missing-project" },
      );
      expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

      const dependencyId = related.data!.projectDependencyCreate.dependency.id as string;
      const deleted = await request(
        `mutation($id: ID!) { projectDependencyDelete(id: $id) { success } }`,
        { id: dependencyId },
      );
      expect(deleted.errors).toBeUndefined();
      expect(deleted.data!.projectDependencyDelete).toEqual({ success: true });
    } finally {
      server.stop(true);
      db.close();
      await persistence.close();
      await harness.close();
    }
  });
});
