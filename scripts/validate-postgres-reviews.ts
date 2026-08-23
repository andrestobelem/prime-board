/**
 * Smoke GraphQL del dominio Reviews contra un schema PostgreSQL aislado.
 * Uso: PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-postgres-reviews.ts
 */
import { openDatabase } from "../apps/server/src/db/database.ts";
import { bootstrapPostgres } from "../apps/server/src/db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../apps/server/src/db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../apps/server/src/db/postgres/persistence.ts";
import { resolveBootstrapIdentity } from "../apps/server/src/db/bootstrap-config.ts";
import { createApp } from "../apps/server/src/server.ts";
import type { Config } from "../apps/server/src/config.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const harness = await createPostgresHarness({
  url,
  schemaPrefix: "prime_board_reviews",
  lockKey: "prime-board-reviews-validation",
});
const db = openDatabase(":memory:");
const persistence = createPostgresPersistence(harness.sql, { close: false });
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
  bootstrap: resolveBootstrapIdentity({}),
};

type GraphqlResponse = {
  data?: Record<string, any>;
  errors?: Array<{ extensions?: { code?: string } }>;
};

let server: ReturnType<typeof createApp>["server"] | undefined;
let adminKey = "";
const report: Record<string, boolean> = {};

async function graphql(
  base: string,
  query: string,
  variables?: Record<string, unknown>,
  token = adminKey,
): Promise<GraphqlResponse> {
  const response = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GraphqlResponse;
}

try {
  const seeded = await bootstrapPostgres(persistence, config.bootstrap);
  adminKey = seeded.adminApiKey ?? "";
  if (!adminKey) throw new Error("Validation requires a fresh PostgreSQL schema");

  const app = createApp({ db, config, persistence });
  server = app.server;
  const base = `http://127.0.0.1:${server.port}`;

  const team = await graphql(base, "{ teams { id key } }");
  const teamId = team.data?.teams[0]?.id;
  const actor = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          actor {
            id
          }
        }
      }
    `,
    { input: { name: "Review PostgreSQL Agent", type: "AGENT" } },
  );
  const reviewerId = actor.data?.actorCreate.actor.id;
  const membership = await graphql(
    base,
    `
      mutation ($input: TeamMembershipCreateInput!) {
        teamMembershipCreate(input: $input) {
          success
        }
      }
    `,
    { input: { teamId, actorId: reviewerId, role: "MEMBER" } },
  );
  const reviewerKeyResult = await graphql(
    base,
    `
      mutation ($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "reviewer key" }) {
          key
        }
      }
    `,
    { actorId: reviewerId },
  );
  const reviewerKey = reviewerKeyResult.data?.apiKeyCreate.key;

  const issue = await graphql(
    base,
    `
      mutation ($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue {
            id
          }
        }
      }
    `,
    { input: { teamId, title: "Review PostgreSQL issue" } },
  );
  const issueId = issue.data?.issueCreate.issue.id;
  const createOne = await graphql(
    base,
    `
      mutation ($input: ReviewCreateInput!) {
        reviewCreate(input: $input) {
          success
          review {
            id
            status
            issue {
              id
            }
            requester {
              id
            }
            reviewer {
              id
            }
          }
        }
      }
    `,
    { input: { issueId, reviewerId } },
  );
  const createTwo = await graphql(
    base,
    `
      mutation ($input: ReviewCreateInput!) {
        reviewCreate(input: $input) {
          review {
            id
            status
            createdAt
          }
        }
      }
    `,
    { input: { issueId, reviewerId } },
  );
  const reviewId = createOne.data?.reviewCreate.review.id;
  const secondReviewId = createTwo.data?.reviewCreate.review.id;
  const list = await graphql(
    base,
    `{ reviews(first: 1, reviewerId: "${reviewerId}") {
      nodes { id status reviewer { id } }
      pageInfo { hasNextPage endCursor }
    } }`,
    undefined,
    reviewerKey,
  );
  const listNext = await graphql(
    base,
    `{ reviews(first: 1, after: "${list.data?.reviews.pageInfo.endCursor}", reviewerId: "${reviewerId}") {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    } }`,
    undefined,
    reviewerKey,
  );
  const approved = await graphql(
    base,
    `
      mutation ($id: ID!) {
        reviewUpdate(id: $id, input: { status: APPROVED }) {
          review {
            id
            status
          }
        }
      }
    `,
    { id: reviewId },
    reviewerKey,
  );
  const open = await graphql(
    base,
    `{ reviews(openOnly: true, reviewerId: "${reviewerId}") {
      nodes { id status }
      pageInfo { hasNextPage endCursor }
    } }`,
    undefined,
    reviewerKey,
  );
  const filtered = await graphql(
    base,
    `
      {
        reviews(reviewerId: "missing-reviewer") {
          nodes {
            id
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    undefined,
    reviewerKey,
  );
  const outsider = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          actor {
            id
          }
        }
      }
    `,
    { input: { name: "Review PostgreSQL Outsider", type: "AGENT" } },
  );
  const outsiderKeyResult = await graphql(
    base,
    `
      mutation ($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "outsider key" }) {
          key
        }
      }
    `,
    { actorId: outsider.data?.actorCreate.actor.id },
  );
  const hidden = await graphql(
    `http://127.0.0.1:${server.port}`,
    `{ review(id: "${reviewId}") { id } }`,
    undefined,
    outsiderKeyResult.data?.apiKeyCreate.key,
  );
  const deleted = await graphql(
    base,
    `
      mutation ($id: ID!) {
        reviewDelete(id: $id) {
          success
        }
      }
    `,
    { id: secondReviewId },
  );
  const constraints = await persistence.many<{ constraint_name: string }>(
    `SELECT constraint_name
     FROM information_schema.table_constraints
     WHERE table_schema = current_schema()
       AND table_name = 'reviews'
       AND constraint_name IN ('reviews_issue_fkey', 'reviews_requester_fkey', 'reviews_reviewer_fkey')`,
  );

  report.contract =
    !team.errors && !actor.errors && !membership.errors && !reviewerKeyResult.errors;
  report.create =
    !issue.errors &&
    !createOne.errors &&
    createOne.data?.reviewCreate.review.status === "REQUESTED" &&
    createOne.data?.reviewCreate.review.issue.id === issueId &&
    createOne.data?.reviewCreate.review.reviewer.id === reviewerId;
  report.list =
    !list.errors &&
    list.data?.reviews.nodes.length === 1 &&
    list.data?.reviews.nodes[0].reviewer.id === reviewerId &&
    list.data?.reviews.pageInfo.hasNextPage === true &&
    typeof list.data?.reviews.pageInfo.endCursor === "string";
  report.pagination =
    !listNext.errors &&
    listNext.data?.reviews.nodes.length === 1 &&
    listNext.data?.reviews.pageInfo.hasNextPage === false;
  report.updateAndFilter =
    !approved.errors &&
    approved.data?.reviewUpdate.review.status === "APPROVED" &&
    !open.errors &&
    open.data?.reviews.nodes.every((review: { status: string }) => review.status !== "APPROVED") &&
    !filtered.errors &&
    filtered.data?.reviews.nodes.length === 0 &&
    filtered.data?.reviews.pageInfo.hasNextPage === false;
  report.authorization = !hidden.errors && hidden.data?.review === null;
  report.delete = !deleted.errors && deleted.data?.reviewDelete.success === true;
  report.foreignKeys = constraints.length === 3;

  await persistence.execute("DELETE FROM reviews WHERE issue_id = $1", [issueId]);
  await persistence.execute("DELETE FROM activity WHERE issue_id = $1", [issueId]);
  await persistence.execute("DELETE FROM issues WHERE id = $1", [issueId]);
  const passed = Object.values(report).every(Boolean);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  server?.stop();
  db.close();
  await persistence.close();
  await harness.close();
}
