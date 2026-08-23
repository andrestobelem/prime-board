/**
 * PostgreSQL smoke test for saved views and favorites.
 * Usage: PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-postgres-saved-views.ts
 */
import { openDatabase } from "../apps/server/src/db/database.ts";
import { bootstrapPostgres } from "../apps/server/src/db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../apps/server/src/db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../apps/server/src/db/postgres/persistence.ts";
import { createApp } from "../apps/server/src/server.ts";
import type { Config } from "../apps/server/src/config.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const harness = await createPostgresHarness({ url, schemaPrefix: "saved_views" });
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
    workspaceName: "Saved views validation",
    workspaceUrlKey: "saved-views-validation",
    teamName: "Saved views validation",
    teamKey: "SVT",
  },
};
const seeded = await bootstrapPostgres(persistence, config.bootstrap);
if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not create an admin key");
const app = createApp({ db, config, persistence });
const endpoint = `http://127.0.0.1:${app.server.port}/graphql`;

type GraphqlResult = {
  data?: Record<string, any>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};
async function graphql(
  query: string,
  variables?: Record<string, unknown>,
  token = seeded.adminApiKey!,
): Promise<GraphqlResult> {
  const response = await fetch(endpoint, {
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
  const viewerId = initial.data?.viewer.id as string;
  const teamId = initial.data?.teams[0]?.id as string;

  const personal = await graphql(
    `
      mutation ($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) {
          savedView {
            id
            scope
            filter
            columns
          }
        }
      }
    `,
    {
      input: {
        name: "Personal validation",
        scope: "PERSONAL",
        filter: { priority: { eq: 2 } },
        columns: ["title", "priority"],
      },
    },
  );
  const personalId = personal.data?.savedViewCreate.savedView.id as string;
  const teamView = await graphql(
    `
      mutation ($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) {
          savedView {
            id
            scope
            team {
              id
            }
          }
        }
      }
    `,
    { input: { name: "Team validation", scope: "TEAM", teamId } },
  );
  const teamViewId = teamView.data?.savedViewCreate.savedView.id as string;
  const workspace = await graphql(
    `
      mutation ($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) {
          savedView {
            id
            scope
          }
        }
      }
    `,
    { input: { name: "Workspace validation", scope: "WORKSPACE" } },
  );
  const workspaceId = workspace.data?.savedViewCreate.savedView.id as string;

  const updated = await graphql(
    `
      mutation ($id: ID!, $input: SavedViewUpdateInput!) {
        savedViewUpdate(id: $id, input: $input) {
          savedView {
            id
            filter
            orderBy
            groupBy
            columns
          }
        }
      }
    `,
    {
      id: personalId,
      input: {
        filter: { state: { eq: "started" } },
        orderBy: "UPDATED_ASC",
        groupBy: "priority",
        columns: ["title"],
      },
    },
  );
  const duplicate = await graphql(
    `
      mutation ($id: ID!) {
        savedViewDuplicate(id: $id) {
          savedView {
            id
            name
          }
        }
      }
    `,
    { id: personalId },
  );
  const archived = await graphql(
    `
      mutation ($id: ID!, $input: SavedViewUpdateInput!) {
        savedViewUpdate(id: $id, input: $input) {
          savedView {
            archivedAt
          }
        }
      }
    `,
    { id: teamViewId, input: { archived: true } },
  );
  const activeViews = await graphql(`
    {
      savedViews {
        id
      }
    }
  `);
  const archivedViews = await graphql(`
    {
      savedViews(includeArchived: true) {
        id
      }
    }
  `);

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
    { input: { name: "Favorite validation project", teamIds: [teamId] } },
  );
  const projectId = project.data?.projectCreate.project.id as string;
  const projectFavorite = await graphql(
    `
      mutation ($input: FavoriteCreateInput!) {
        favoriteCreate(input: $input) {
          favorite {
            id
            project {
              id
            }
            position
          }
        }
      }
    `,
    { input: { projectId } },
  );
  const viewFavorite = await graphql(
    `
      mutation ($input: FavoriteCreateInput!) {
        favoriteCreate(input: $input) {
          favorite {
            id
            savedView {
              id
            }
            position
          }
        }
      }
    `,
    { input: { savedViewId: workspaceId } },
  );
  const favoriteId = projectFavorite.data?.favoriteCreate.favorite.id as string;
  const reordered = await graphql(
    `
      mutation ($id: ID!) {
        favoriteReorder(id: $id, position: 1) {
          favorite {
            id
            position
          }
        }
      }
    `,
    { id: favoriteId },
  );
  const beforeArchive = await graphql(`
    {
      favorites {
        project {
          id
        }
        savedView {
          id
        }
      }
    }
  `);
  await graphql(
    `
      mutation ($id: ID!) {
        projectArchive(id: $id) {
          success
        }
      }
    `,
    { id: projectId },
  );
  const hiddenFavorite = await graphql(`
    {
      favorites {
        project {
          id
        }
        savedView {
          id
        }
      }
    }
  `);
  await graphql(
    `
      mutation ($id: ID!) {
        projectUnarchive(id: $id) {
          success
        }
      }
    `,
    { id: projectId },
  );
  const restoredFavorite = await graphql(`
    {
      favorites {
        project {
          id
        }
        savedView {
          id
        }
      }
    }
  `);

  const limitedKeyResult = await graphql(
    `
      mutation ($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(
          input: {
            actorId: $actorId
            name: "validation limited"
            scopes: [READ]
            teamIds: [$teamId]
          }
        ) {
          key
        }
      }
    `,
    { actorId: viewerId, teamId },
  );
  const limitedKey = limitedKeyResult.data?.apiKeyCreate.key as string;
  const limitedFavorites = await graphql(
    `
      {
        favorites {
          id
        }
      }
    `,
    undefined,
    limitedKey,
  );

  const limitedWriteKeyResult = await graphql(
    `
      mutation ($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(
          input: {
            actorId: $actorId
            name: "validation limited writer"
            scopes: [WRITE]
            teamIds: [$teamId]
          }
        ) {
          key
        }
      }
    `,
    { actorId: viewerId, teamId },
  );
  const limitedWriteKey = limitedWriteKeyResult.data?.apiKeyCreate.key as string;
  const limitedSavedViewQueries = await Promise.all(
    [personalId, workspaceId].map((id) =>
      graphql(
        `
          query ($id: ID!) {
            savedView(id: $id) {
              id
              filter
            }
          }
        `,
        { id },
        limitedWriteKey,
      ),
    ),
  );
  const limitedSavedViewMutations = await Promise.all(
    [personalId, workspaceId].flatMap((id) =>
      [
        `mutation($id: ID!) { savedViewUpdate(id: $id, input: { name: "limited update" }) { success } }`,
        `mutation($id: ID!) { savedViewDuplicate(id: $id) { success } }`,
        `mutation($id: ID!) { savedViewDelete(id: $id) { success } }`,
      ].map((query) => graphql(query, { id }, limitedWriteKey)),
    ),
  );
  const scopedProject = await graphql(
    `
      mutation ($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          project {
            id
          }
        }
      }
    `,
    { input: { name: "Limited favorite project", teamIds: [teamId] } },
  );
  const scopedProjectId = scopedProject.data?.projectCreate.project.id as string;
  const scopedFavorite = await graphql(
    `
      mutation ($input: FavoriteCreateInput!) {
        favoriteCreate(input: $input) {
          favorite {
            id
          }
        }
      }
    `,
    { input: { projectId: scopedProjectId } },
    limitedWriteKey,
  );
  const scopedFavoriteId = scopedFavorite.data?.favoriteCreate.favorite.id as string;
  const limitedFavoriteReorder = await graphql(
    `
      mutation ($id: ID!) {
        favoriteReorder(id: $id, position: 0) {
          favorite {
            id
            position
          }
        }
      }
    `,
    { id: scopedFavoriteId },
    limitedWriteKey,
  );
  const limitedFavoriteDelete = await graphql(
    `
      mutation ($id: ID!) {
        favoriteDelete(id: $id) {
          success
        }
      }
    `,
    { id: scopedFavoriteId },
    limitedWriteKey,
  );

  report.savedViews =
    !personal.errors &&
    personal.data?.savedViewCreate.savedView.filter.priority.eq === 2 &&
    !teamView.errors &&
    !workspace.errors &&
    !updated.errors &&
    updated.data?.savedViewUpdate.savedView.orderBy === "UPDATED_ASC" &&
    !duplicate.errors &&
    !archived.errors &&
    !activeViews.data?.savedViews.some((view: { id: string }) => view.id === teamViewId) &&
    archivedViews.data?.savedViews.some((view: { id: string }) => view.id === teamViewId);
  report.favorites =
    !projectFavorite.errors &&
    !viewFavorite.errors &&
    !reordered.errors &&
    beforeArchive.data?.favorites.length === 2 &&
    hiddenFavorite.data?.favorites.length === 1 &&
    restoredFavorite.data?.favorites.length === 2;
  report.authorization = limitedFavorites.errors?.[0]?.extensions?.code === "UNAUTHORIZED";
  report.savedViewAuthorization =
    limitedSavedViewQueries.every(
      (result) =>
        result.errors?.[0]?.extensions?.code === "UNAUTHORIZED" && !result.data?.savedView,
    ) &&
    limitedSavedViewMutations.every(
      (result) => result.errors?.[0]?.extensions?.code === "UNAUTHORIZED",
    );
  report.favoriteAuthorization =
    !scopedProject.errors &&
    !scopedFavorite.errors &&
    !limitedFavoriteReorder.errors &&
    limitedFavoriteReorder.data?.favoriteReorder.favorite.id === scopedFavoriteId &&
    !limitedFavoriteDelete.errors &&
    limitedFavoriteDelete.data?.favoriteDelete.success === true;

  const passed = Object.values(report).every(Boolean);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} finally {
  app.server.stop(true);
  db.close();
  await persistence.close();
  await harness.close();
}
