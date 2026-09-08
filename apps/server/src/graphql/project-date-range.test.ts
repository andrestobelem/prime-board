// PRB-661: los rangos DateTime de Project usan el valor almacenado en updates parciales.
import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestApp, gql } from "../test-helpers.ts";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

interface GraphqlResponse {
  data?: Record<string, any>;
  errors?: Array<{ extensions?: { code?: string } }>;
}

type GraphqlRequest = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<GraphqlResponse>;

async function runDateRangeScenario(request: GraphqlRequest): Promise<void> {
  const team = await request(`{ team(key: "PB") { id } }`);
  const teamId = team.data!.team.id as string;
  const created = await request(
    `mutation($teamId: ID!) {
      projectCreate(input: {
        name: "Partial date range",
        teamIds: [$teamId],
        startDate: "2026-09-10",
        targetDate: "2026-09-20"
      }) { project { id startDate targetDate } }
    }`,
    { teamId },
  );
  expect(created.errors).toBeUndefined();
  const projectId = created.data!.projectCreate.project.id as string;

  const invalidStart = await request(
    `mutation($id: ID!) {
      projectUpdate(id: $id, input: { startDate: "2026-09-21" }) { success }
    }`,
    { id: projectId },
  );
  expect(invalidStart.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

  const afterInvalidStart = await request(
    `query($id: ID!) { project(id: $id) { startDate targetDate } }`,
    { id: projectId },
  );
  expect(afterInvalidStart.data!.project).toEqual({
    startDate: "2026-09-10",
    targetDate: "2026-09-20",
  });

  const invalidTarget = await request(
    `mutation($id: ID!) {
      projectUpdate(id: $id, input: { targetDate: "2026-09-09" }) { success }
    }`,
    { id: projectId },
  );
  expect(invalidTarget.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

  const afterInvalidTarget = await request(
    `query($id: ID!) { project(id: $id) { startDate targetDate } }`,
    { id: projectId },
  );
  expect(afterInvalidTarget.data!.project).toEqual({
    startDate: "2026-09-10",
    targetDate: "2026-09-20",
  });
}

async function runDateFormatScenario(request: GraphqlRequest): Promise<void> {
  const team = await request(`{ team(key: "PB") { id } }`);
  const teamId = team.data!.team.id as string;
  const equivalentOffsets = await request(
    `mutation($teamId: ID!) {
      projectCreate(input: {
        name: "Equivalent offsets",
        teamIds: [$teamId],
        startDate: "2026-09-02T00:00:00+02:00",
        targetDate: "2026-09-01T22:00:00Z"
      }) { project { startDate targetDate } }
    }`,
    { teamId },
  );
  expect(equivalentOffsets.errors).toBeUndefined();
  expect(equivalentOffsets.data!.projectCreate.project).toEqual({
    startDate: "2026-09-02T00:00:00+02:00",
    targetDate: "2026-09-01T22:00:00Z",
  });

  const dateOnly = await request(
    `mutation($teamId: ID!) {
      projectCreate(input: {
        name: "Date only range",
        teamIds: [$teamId],
        startDate: "2026-09-01",
        targetDate: "2026-09-02"
      }) { project { startDate targetDate } }
    }`,
    { teamId },
  );
  expect(dateOnly.errors).toBeUndefined();
  expect(dateOnly.data!.projectCreate.project).toEqual({
    startDate: "2026-09-01",
    targetDate: "2026-09-02",
  });
}

describe("Project DateTime range validation in SQLite", () => {
  const app = createTestApp();
  afterAll(() => app.stop());

  it("combines each partial update with the stored date and preserves failed writes", async () => {
    await runDateRangeScenario((query, variables) => gql(app, query, variables));
  });

  it("compares equivalent instants and keeps date-only values", async () => {
    await runDateFormatScenario((query, variables) => gql(app, query, variables));
  });
});

const postgresIntegration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("Project DateTime range validation in PostgreSQL", () => {
  postgresIntegration("combines partial updates and compares normalized instants", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb661_project_dates",
      lockKey: `prb661-project-dates-${randomUUID()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    const db = openDatabase(":memory:");
    let stop: (() => void) | undefined;
    try {
      const seeded = await bootstrapPostgres(persistence);
      if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
      const bootstrap = resolveBootstrapIdentity({});
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
        bootstrap,
      } as Config;
      const app = createApp({ db, config, persistence });
      stop = () => app.server.stop();
      const request: GraphqlRequest = async (query, variables = {}) => {
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

      await runDateRangeScenario(request);
      await runDateFormatScenario(request);
    } finally {
      stop?.();
      db.close();
      await persistence.close();
      await harness.close();
    }
  });
});
