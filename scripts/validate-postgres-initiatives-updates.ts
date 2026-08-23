/**
 * Smoke GraphQL de Initiatives y Project Updates sobre PostgreSQL.
 *
 * La auditoría durable de Initiatives y Project Updates queda fuera de este
 * smoke y de PRB-440. Se conserva como trabajo aceptado de PRB-445/PRB-446.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../apps/server/src/db/database.ts";
import { bootstrapPostgres } from "../apps/server/src/db/postgres/bootstrap.ts";
import { createPostgresPersistence } from "../apps/server/src/db/postgres/persistence.ts";
import { createPostgresHarness } from "../apps/server/src/db/postgres/test-harness.ts";
import { exportPostgresBoard } from "../apps/server/src/export/postgres-export.ts";
import { createApp } from "../apps/server/src/server.ts";
import type { Config } from "../apps/server/src/config.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}
const harness = await createPostgresHarness({ url, schemaPrefix: "initiatives-updates" });
const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, { close: false });
const db = openDatabase(":memory:");
const config: Config = {
  port: 0,
  host: "127.0.0.1",
  authMode: "api-key",
  dbPath: ":memory:",
  postgresUrl: url,
  persistenceBackend: "postgres",
  dev: false,
  webDist: "/tmp/prime-board-no-web",
  repoRoot: null,
  bootstrap: {
    workspaceName: "Initiatives validation",
    workspaceUrlKey: "initiatives-validation",
    teamName: "Initiatives validation",
    teamKey: "INV",
  },
};
const seeded = await bootstrapPostgres(persistence, config.bootstrap);
if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not create an admin key");
const app = createApp({ db, config, persistence });
const base = `http://127.0.0.1:${app.server.port}`;
type Result = { data?: any; errors?: Array<{ message: string }> };
async function graphql(query: string, variables?: Record<string, unknown>): Promise<Result> {
  const response = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${seeded.adminApiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as Result;
}
const report: Record<string, boolean> = {};
let exportRoot: string | null = null;
try {
  const teams = await graphql(`
    {
      teams {
        id
      }
    }
  `);
  const teamId = teams.data?.teams?.[0]?.id as string | undefined;
  if (!teamId) throw new Error("PostgreSQL smoke did not create a Team");
  const project = await graphql(
    `
      mutation ($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          project {
            id
          }
        }
      }
    `,
    { input: { name: "Initiative project", teamIds: [teamId] } },
  );
  const projectId = project.data?.projectCreate?.project?.id as string | undefined;
  if (!projectId) throw new Error("PostgreSQL smoke did not create a Project");
  const created = await graphql(
    `
      mutation ($input: InitiativeCreateInput!) {
        initiativeCreate(input: $input) {
          initiative {
            id
            projects {
              id
            }
            teams {
              id
            }
            progress
          }
        }
      }
    `,
    {
      input: {
        name: "Roadmap",
        projectIds: [projectId],
        teamIds: [teamId],
        targetDate: "2030-02-01T00:00:00.000Z",
      },
    },
  );
  const initiativeId = created.data?.initiativeCreate?.initiative?.id as string | undefined;
  if (!initiativeId) throw new Error("PostgreSQL smoke did not create an Initiative");
  const update = await graphql(
    `
      mutation ($input: ProjectUpdateCreateInput!) {
        projectUpdateCreate(input: $input) {
          projectUpdate {
            id
            project {
              id
            }
            health
            body
          }
        }
      }
    `,
    { input: { projectId, health: "ON_TRACK", body: "All work is on track" } },
  );
  const updates = await graphql(
    `
      query ($id: ID!) {
        project(id: $id) {
          updates {
            id
            health
            body
          }
        }
      }
    `,
    { id: projectId },
  );
  const updateId = update.data?.projectUpdateCreate?.projectUpdate?.id as string | undefined;
  if (!updateId) throw new Error("PostgreSQL smoke did not create a Project Update");
  const changed = await graphql(
    `
      mutation ($id: ID!, $input: InitiativeUpdateInput!) {
        initiativeUpdate(id: $id, input: $input) {
          initiative {
            state
            archivedAt
          }
        }
      }
    `,
    { id: initiativeId, input: { state: "ACTIVE", archived: true } },
  );
  exportRoot = mkdtempSync(join(tmpdir(), "prime-board-postgres-initiatives-updates-"));
  const exportResult = await exportPostgresBoard(persistence, exportRoot);
  const exportedInitiatives = JSON.parse(
    readFileSync(join(exportRoot, ".prime-board", "meta", "initiatives.json"), "utf8"),
  ) as Array<{ name: string; projects: string[] }>;
  const exportedUpdates = JSON.parse(
    readFileSync(join(exportRoot, ".prime-board", "meta", "project-updates.json"), "utf8"),
  ) as Array<{ project: string; body: string }>;
  report.export =
    exportResult.files > 0 &&
    exportedInitiatives.some(
      (initiative) =>
        initiative.name === "Roadmap" && initiative.projects.includes("Initiative project"),
    ) &&
    exportedUpdates.some(
      (update) => update.project === "Initiative project" && update.body === "All work is on track",
    );

  const deletedUpdate = await graphql(
    `
      mutation ($id: ID!) {
        projectUpdateDelete(id: $id) {
          success
        }
      }
    `,
    {
      id: updateId,
    },
  );
  const deleted = await graphql(
    `
      mutation ($id: ID!) {
        initiativeDelete(id: $id) {
          success
        }
      }
    `,
    { id: initiativeId },
  );
  report.initiativeRelations =
    !created.errors &&
    created.data?.initiativeCreate?.initiative?.projects?.[0]?.id === projectId &&
    created.data?.initiativeCreate?.initiative?.teams?.[0]?.id === teamId;
  report.projectUpdates =
    !update.errors &&
    !updates.errors &&
    updates.data?.project?.updates?.length === 1 &&
    updates.data.project.updates[0].body === "All work is on track";
  report.stateArchive =
    !changed.errors &&
    changed.data?.initiativeUpdate?.initiative?.state?.toLowerCase() === "active" &&
    changed.data?.initiativeUpdate?.initiative?.archivedAt !== null;
  report.cascadeDeletes =
    !deletedUpdate.errors &&
    deletedUpdate.data?.projectUpdateDelete?.success === true &&
    !deleted.errors &&
    deleted.data?.initiativeDelete?.success === true;
  const passed = Object.values(report).every(Boolean);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} finally {
  app.server.stop(true);
  db.close();
  await persistence.close();
  await harness.close();
  if (exportRoot) rmSync(exportRoot, { recursive: true, force: true });
}
