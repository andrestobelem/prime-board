/** Smoke GraphQL de Milestones y Cycles sobre PostgreSQL. */
import { openDatabase } from "../apps/server/src/db/database.ts";
import { bootstrapPostgres } from "../apps/server/src/db/postgres/bootstrap.ts";
import { createPostgresPersistence } from "../apps/server/src/db/postgres/persistence.ts";
import { createPostgresHarness } from "../apps/server/src/db/postgres/test-harness.ts";
import { createApp } from "../apps/server/src/server.ts";
import type { Config } from "../apps/server/src/config.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const harness = await createPostgresHarness({ url, schemaPrefix: "milestones-cycles" });
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
    workspaceName: "Milestones and cycles validation",
    workspaceUrlKey: "milestones-cycles-validation",
    teamName: "Milestones and cycles validation",
    teamKey: "MCV",
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
try {
  const teams =
    await graphql(`
      {
        teams {
          id
        }
      }
    `);
  const teamId = teams.data?.teams[0]?.id as string;
  const project = await graphql(
    `
      mutation ($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          project {
            id
            milestones {
              id
            }
          }
        }
      }
    `,
    { input: { name: "Milestone project", teamIds: [teamId] } },
  );
  const projectId = project.data?.projectCreate.project.id as string;
  const milestone = await graphql(
    `
      mutation ($input: MilestoneCreateInput!) {
        milestoneCreate(input: $input) {
          milestone {
            id
            name
            position
            project {
              id
            }
          }
        }
      }
    `,
    { input: { projectId, name: "Release", targetDate: "2030-01-02T00:00:00.000Z" } },
  );
  const milestoneId = milestone.data?.milestoneCreate.milestone.id as string;
  const issue = await graphql(
    `
      mutation ($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue {
            id
            milestone {
              id
            }
            activity {
              type
              actor {
                id
              }
              payload
            }
          }
        }
      }
    `,
    { input: { teamId, title: "Milestone issue", projectId, milestoneId } },
  );
  const issueId = issue.data?.issueCreate.issue.id as string;
  const c1 = await graphql(
    `
      mutation ($input: CycleCreateInput!) {
        cycleCreate(input: $input) {
          cycle {
            id
            number
          }
        }
      }
    `,
    {
      input: {
        teamId,
        name: "Cycle one",
        startsAt: "2030-01-01T00:00:00.000Z",
        endsAt: "2030-01-07T00:00:00.000Z",
      },
    },
  );
  const c1Id = c1.data?.cycleCreate.cycle.id as string;
  const c2 = await graphql(
    `
      mutation ($input: CycleCreateInput!) {
        cycleCreate(input: $input) {
          cycle {
            id
            number
          }
        }
      }
    `,
    {
      input: {
        teamId,
        name: "Cycle two",
        startsAt: "2030-01-08T00:00:00.000Z",
        endsAt: "2030-01-14T00:00:00.000Z",
      },
    },
  );
  const c2Id = c2.data?.cycleCreate.cycle.id as string;
  const assign = await graphql(
    `
      mutation ($id: ID!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          issue {
            cycle {
              id
            }
          }
        }
      }
    `,
    { id: issueId, input: { cycleId: c1Id } },
  );
  const progress = await graphql(
    `
      query ($id: ID!) {
        cycle(id: $id) {
          progress
          totalIssues
        }
      }
    `,
    { id: c1Id },
  );
  const carry = await graphql(
    `
      mutation ($from: ID!, $to: ID!) {
        cycleCarryOver(fromCycleId: $from, toCycleId: $to) {
          movedIssues
        }
      }
    `,
    { from: c1Id, to: c2Id },
  );
  const archive = await graphql(
    `
      mutation ($id: ID!) {
        cycleUpdate(id: $id, input: { archived: true }) {
          cycle {
            archivedAt
          }
        }
      }
    `,
    { id: c2Id },
  );
  const milestoneDelete = await graphql(
    `
      mutation ($id: ID!) {
        milestoneDelete(id: $id) {
          orphanedIssues
        }
      }
    `,
    { id: milestoneId },
  );
  report.milestoneCrud =
    !project.errors &&
    !milestone.errors &&
    milestone.data?.milestoneCreate.milestone.project.id === projectId;
  report.issueMilestoneActivity =
    !issue.errors &&
    issue.data?.issueCreate.issue.milestone.id === milestoneId &&
    issue.data.issueCreate.issue.activity.length > 0;
  report.cycleCrud =
    !c1.errors &&
    !c2.errors &&
    c1.data?.cycleCreate.cycle.number === 1 &&
    c2.data?.cycleCreate.cycle.number === 2;
  report.progress = !progress.errors && progress.data?.cycle.totalIssues === 1;
  report.carryOver =
    !assign.errors && !carry.errors && carry.data?.cycleCarryOver.movedIssues === 1;
  report.archive = !archive.errors && archive.data?.cycleUpdate.cycle.archivedAt !== null;
  report.delete =
    !milestoneDelete.errors && milestoneDelete.data?.milestoneDelete.orphanedIssues === 1;
  const passed = Object.values(report).every(Boolean);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} finally {
  app.server.stop(true);
  db.close();
  await persistence.close();
  await harness.close();
}
