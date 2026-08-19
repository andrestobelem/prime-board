/**
 * Valida aislamiento de schemas y un smoke GraphQL sobre PostgreSQL.
 * Uso: PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-postgres-harness.ts
 */
import { createSchema, createYoga } from "../apps/server/node_modules/graphql-yoga";
import { createPostgresHarness } from "../apps/server/src/db/postgres/test-harness.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const report: Record<string, unknown> = {};
let first: Awaited<ReturnType<typeof createPostgresHarness>> | undefined;
let second: Awaited<ReturnType<typeof createPostgresHarness>> | undefined;
try {
  [first, second] = await Promise.all([
    createPostgresHarness({ url, schemaPrefix: "parallel_a" }),
    createPostgresHarness({ url, schemaPrefix: "parallel_b" }),
  ]);
  await first.sql`
    INSERT INTO workspace (id, name, url_key, created_at, updated_at)
    VALUES ('workspace-a', 'Workspace A', 'workspace-a', '2026-01-01', '2026-01-01')
  `;
  await second.sql`
    INSERT INTO workspace (id, name, url_key, created_at, updated_at)
    VALUES ('workspace-b', 'Workspace B', 'workspace-b', '2026-01-01', '2026-01-01')
  `;
  const firstNames = await first.sql`SELECT name FROM workspace`;
  const secondNames = await second.sql`SELECT name FROM workspace`;
  report.isolation =
    firstNames.length === 1 &&
    firstNames[0]?.name === "Workspace A" &&
    secondNames.length === 1 &&
    secondNames[0]?.name === "Workspace B";

  const schema = createSchema({
    typeDefs: `
      type Workspace { name: String!, urlKey: String! }
      type Query { workspace: Workspace!, workspaceCount: Int! }
    `,
    resolvers: {
      Query: {
        workspace: async () => {
          const rows = await first!.sql`SELECT name, url_key AS "urlKey" FROM workspace LIMIT 1`;
          return rows[0];
        },
        workspaceCount: async () => {
          const rows = await first!.sql`SELECT count(*)::int AS count FROM workspace`;
          return rows[0]?.count;
        },
      },
    },
  });
  const yoga = createYoga({ schema, graphqlEndpoint: "/graphql" });
  const response = await yoga.fetch(
    new Request("http://postgres.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ workspace { name urlKey } workspaceCount }" }),
    }),
  );
  const body = (await response.json()) as {
    data?: { workspace: { name: string; urlKey: string }; workspaceCount: number };
    errors?: unknown[];
  };
  report.graphql =
    response.status === 200 &&
    body.errors === undefined &&
    body.data?.workspace.name === "Workspace A" &&
    body.data.workspace.urlKey === "workspace-a" &&
    body.data.workspaceCount === 1;

  const passed = report.isolation === true && report.graphql === true;
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await Promise.all([first?.close(), second?.close()]);
}
