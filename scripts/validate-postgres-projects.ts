/**
 * Smoke GraphQL de Projects, sus asociaciones y su autorización en PostgreSQL.
 * Uso: PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-postgres-projects.ts
 */
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

const harness = await createPostgresHarness({ url, schemaPrefix: "projects" });
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
    workspaceName: "Projects validation",
    workspaceUrlKey: "projects-validation",
    teamName: "Projects validation",
    teamKey: "PVT",
  },
};
const seeded = await bootstrapPostgres(persistence, config.bootstrap);
if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not create an admin key");
const app = createApp({ db, config, persistence });
const base = `http://127.0.0.1:${app.server.port}`;

type GraphqlResult = { data?: any; errors?: Array<{ message: string }> };
async function graphql(
  query: string,
  variables?: Record<string, unknown>,
  token = seeded.adminApiKey!,
): Promise<GraphqlResult> {
  const response = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GraphqlResult;
}

const report: Record<string, boolean> = {};
try {
  const initial = await graphql(`
    {
      viewer {
        id
      }
      teams {
        id
      }
    }
  `);
  const firstTeamId = initial.data?.teams[0]?.id as string;
  const secondTeamResult = await graphql(`
    mutation {
      teamCreate(input: { name: "Projects second", key: "PV2" }) {
        team {
          id
        }
      }
    }
  `);
  const secondTeamId = secondTeamResult.data?.teamCreate.team.id as string;

  const multiProject = await graphql(
    `
      mutation ($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          project {
            id
            teams {
              id
            }
          }
        }
      }
    `,
    { input: { name: "Multi-Team project", teamIds: [firstTeamId, secondTeamId] } },
  );
  const multiProjectId = multiProject.data?.projectCreate.project.id as string;
  const singleProject = await graphql(
    `
      mutation ($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          project {
            id
          }
        }
      }
    `,
    { input: { name: "Single-Team project", teamIds: [firstTeamId] } },
  );
  const singleProjectId = singleProject.data?.projectCreate.project.id as string;

  const teamProjects = await graphql(
    `
      query ($id: ID!) {
        team(id: $id) {
          projects {
            id
          }
        }
      }
    `,
    { id: firstTeamId },
  );
  const issue = await graphql(
    `
      mutation ($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue {
            id
            project {
              id
            }
          }
        }
      }
    `,
    { input: { teamId: firstTeamId, title: "Project issue", projectId: singleProjectId } },
  );
  const issueId = issue.data?.issueCreate.issue.id as string;
  const multiIssue = await graphql(
    `
      mutation ($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue {
            id
            project {
              id
            }
          }
        }
      }
    `,
    {
      input: { teamId: firstTeamId, title: "Multi-Team project issue", projectId: multiProjectId },
    },
  );
  const issueUpdate = await graphql(
    `
      mutation ($id: ID!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          issue {
            project {
              id
            }
          }
        }
      }
    `,
    { id: issueId, input: { projectId: null } },
  );
  const projectUpdate = await graphql(
    `
      mutation ($id: ID!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          project {
            name
            state
            teams {
              id
            }
          }
        }
      }
    `,
    {
      id: multiProjectId,
      input: { name: "Updated multi project", state: "STARTED" },
    },
  );
  const archived = await graphql(
    `
      mutation ($id: ID!) {
        projectArchive(id: $id) {
          project {
            archivedAt
          }
        }
      }
    `,
    { id: singleProjectId },
  );
  const restored = await graphql(
    `
      mutation ($id: ID!) {
        projectUnarchive(id: $id) {
          project {
            archivedAt
          }
        }
      }
    `,
    { id: singleProjectId },
  );

  const limitedKeyResult = await graphql(
    `
      mutation ($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(
          input: {
            actorId: $actorId
            name: "Projects limited"
            scopes: [READ, WRITE]
            teamIds: [$teamId]
          }
        ) {
          key
        }
      }
    `,
    { actorId: initial.data?.viewer.id, teamId: firstTeamId },
  );
  const limitedKey = limitedKeyResult.data?.apiKeyCreate.key as string;
  const limitedProjects = await graphql(
    `
      {
        projects {
          id
        }
      }
    `,
    undefined,
    limitedKey,
  );
  const limitedMulti = await graphql(
    `
      query ($id: ID!) {
        project(id: $id) {
          id
        }
      }
    `,
    { id: multiProjectId },
    limitedKey,
  );
  const limitedProjectIssues = await graphql(
    `
      query ($projectId: ID!) {
        issues(filter: { project: { eq: $projectId } }) {
          nodes {
            id
          }
        }
      }
    `,
    { projectId: multiProjectId },
    limitedKey,
  );

  report.crud =
    !multiProject.errors &&
    !singleProject.errors &&
    !projectUpdate.errors &&
    projectUpdate.data?.projectUpdate.project.name === "Updated multi project" &&
    projectUpdate.data?.projectUpdate.project.state === "STARTED";
  report.relationships =
    !teamProjects.errors &&
    teamProjects.data?.team.projects.some(
      (project: { id: string }) => project.id === multiProjectId,
    ) &&
    !issue.errors &&
    issue.data?.issueCreate.issue.project.id === singleProjectId &&
    !multiIssue.errors &&
    multiIssue.data?.issueCreate.issue.project.id === multiProjectId &&
    !issueUpdate.errors &&
    issueUpdate.data?.issueUpdate.issue.project === null;
  report.archive =
    !archived.errors &&
    archived.data?.projectArchive.project.archivedAt !== null &&
    !restored.errors &&
    restored.data?.projectUnarchive.project.archivedAt === null;
  report.authorization =
    !limitedProjects.errors &&
    !limitedProjects.data?.projects.some(
      (project: { id: string }) => project.id === multiProjectId,
    ) &&
    !limitedMulti.errors &&
    limitedMulti.data?.project === null &&
    !limitedProjectIssues.errors &&
    limitedProjectIssues.data?.issues.nodes.length === 0;
  const passed = Object.values(report).every(Boolean);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} finally {
  app.server.stop(true);
  db.close();
  await persistence.close();
  await harness.close();
}
