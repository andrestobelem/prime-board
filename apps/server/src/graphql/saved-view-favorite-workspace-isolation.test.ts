// PRB-476: las vistas guardadas y los favoritos respetan el Workspace efectivo.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let legacyApp: TestApp;
let defaultTeamId: string;
let defaultProjectId: string;
let defaultViewId: string;
let defaultFavoriteId: string;
let otherTeamId: string;
let otherProjectId: string;

const errorCode = (result: { errors?: Array<{ extensions?: { code?: string } }> }) =>
  result.errors?.[0]?.extensions?.code;

beforeAll(async () => {
  app = createTestApp();
  const defaultTeam = await gql(app, `{ team(key: "PB") { id } }`);
  defaultTeamId = defaultTeam.data!.team.id as string;

  const project = await gql(
    app,
    `mutation($teamId: ID!) {
      projectCreate(input: { name: "Default saved-view project", teamIds: [$teamId] }) {
        project { id }
      }
    }`,
    { teamId: defaultTeamId },
  );
  defaultProjectId = project.data!.projectCreate.project.id as string;

  const view = await gql(
    app,
    `mutation($teamId: ID!) {
      savedViewCreate(input: { name: "Default team view", scope: TEAM, teamId: $teamId }) {
        savedView { id }
      }
    }`,
    { teamId: defaultTeamId },
  );
  defaultViewId = view.data!.savedViewCreate.savedView.id as string;

  const favorite = await gql(
    app,
    `mutation($viewId: ID!) {
      favoriteCreate(input: { savedViewId: $viewId }) { favorite { id } }
    }`,
    { viewId: defaultViewId },
  );
  defaultFavoriteId = favorite.data!.favoriteCreate.favorite.id as string;

  const workspace = await gql(
    app,
    `mutation {
      workspaceCreate(input: { name: "Saved views other", urlKey: "saved-views-other" }) {
        workspace { id urlKey }
      }
    }`,
  );
  expect(workspace.errors).toBeUndefined();

  const otherTeam = await gql(app, `{ teams { id key } }`, {}, app.apiKey, "saved-views-other");
  otherTeamId = otherTeam.data!.teams[0].id as string;
  const otherProject = await gql(
    app,
    `mutation($teamId: ID!) {
      projectCreate(input: { name: "Other saved-view project", teamIds: [$teamId] }) {
        project { id }
      }
    }`,
    { teamId: otherTeamId },
    app.apiKey,
    "saved-views-other",
  );
  otherProjectId = otherProject.data!.projectCreate.project.id as string;
});

afterAll(() => {
  app.stop();
  legacyApp?.stop();
});

describe("aislamiento de Saved Views y Favorites", () => {
  it("rechaza crear una Saved View con Team de otro Workspace", async () => {
    const result = await gql(
      app,
      `mutation($teamId: ID!) {
        savedViewCreate(input: { name: "cross-workspace", scope: TEAM, teamId: $teamId }) {
          success
        }
      }`,
      { teamId: defaultTeamId },
      app.apiKey,
      "saved-views-other",
    );

    expect(errorCode(result)).toBe("NOT_FOUND");
    const count = app.db
      .query("SELECT count(*) AS count FROM saved_views WHERE name = ?1")
      .get("cross-workspace") as { count: number };
    expect(count.count).toBe(0);
  });

  it("rechaza Favorites que apuntan a recursos de otro Workspace", async () => {
    const projectFavorite = await gql(
      app,
      `mutation($projectId: ID!) {
        favoriteCreate(input: { projectId: $projectId }) { success }
      }`,
      { projectId: defaultProjectId },
      app.apiKey,
      "saved-views-other",
    );
    expect(errorCode(projectFavorite)).toBe("NOT_FOUND");

    const viewFavorite = await gql(
      app,
      `mutation($savedViewId: ID!) {
        favoriteCreate(input: { savedViewId: $savedViewId }) { success }
      }`,
      { savedViewId: defaultViewId },
      app.apiKey,
      "saved-views-other",
    );
    expect(errorCode(viewFavorite)).toBe("NOT_FOUND");
  });

  it("oculta recursos y rechaza reorder cross-Workspace", async () => {
    const result = await gql(
      app,
      `query($viewId: ID!, $projectId: ID!) {
        savedView(id: $viewId) { id }
        savedViews { id }
        favorites { id }
        project(id: $projectId) { id }
      }`,
      { viewId: defaultViewId, projectId: defaultProjectId },
      app.apiKey,
      "saved-views-other",
    );
    expect(result.errors).toBeUndefined();
    expect(result.data!.savedView).toBeNull();
    expect(result.data!.savedViews).toEqual([]);
    expect(result.data!.favorites).toEqual([]);
    expect(result.data!.project).toBeNull();

    const reorder = await gql(
      app,
      `mutation($id: ID!) { favoriteReorder(id: $id, position: 0) { success } }`,
      { id: defaultFavoriteId },
      app.apiKey,
      "saved-views-other",
    );
    expect(errorCode(reorder)).toBe("NOT_FOUND");
    expect(otherProjectId).toBeTruthy();
  });

  it("conserva la visibilidad legacy de NULL con un único Workspace", async () => {
    legacyApp = createTestApp();
    const viewer = legacyApp.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as {
      id: string;
    };
    legacyApp.db
      .query(
        `INSERT INTO saved_views
          (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
           columns_json, created_at, updated_at, archived_at, workspace_id)
         VALUES (?1, ?2, 'workspace', NULL, ?3, '{}', 'CREATED_DESC', 'state', '[]',
                 ?4, ?4, NULL, NULL)`,
      )
      .run("legacy-null-view", "Legacy NULL view", viewer.id, new Date().toISOString());

    legacyApp.db
      .query("UPDATE saved_views SET workspace_id = NULL WHERE id = ?1")
      .run("legacy-null-view");

    const result = await gql(legacyApp, `query { savedView(id: "legacy-null-view") { id name } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data!.savedView).toEqual({ id: "legacy-null-view", name: "Legacy NULL view" });

    const updated = await gql(
      legacyApp,
      `mutation { savedViewUpdate(id: "legacy-null-view", input: { name: "Legacy renamed" }) { savedView { name } } }`,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.savedViewUpdate.savedView.name).toBe("Legacy renamed");

    const favorite = await gql(
      legacyApp,
      `mutation { favoriteCreate(input: { savedViewId: "legacy-null-view" }) { favorite { id } } }`,
    );
    expect(favorite.errors).toBeUndefined();
    const favoriteId = favorite.data!.favoriteCreate.favorite.id as string;
    const listed = await gql(legacyApp, `{ favorites { id savedView { id } } }`);
    expect(listed.errors).toBeUndefined();
    expect(listed.data!.favorites).toEqual([
      { id: favoriteId, savedView: { id: "legacy-null-view" } },
    ]);

    const reordered = await gql(
      legacyApp,
      `mutation($id: ID!) { favoriteReorder(id: $id, position: 0) { favorite { id } } }`,
      { id: favoriteId },
    );
    expect(reordered.errors).toBeUndefined();

    const deletedView = await gql(
      legacyApp,
      `mutation { savedViewDelete(id: "legacy-null-view") { success } }`,
    );
    expect(deletedView.errors).toBeUndefined();
    expect(deletedView.data!.savedViewDelete.success).toBe(true);
    const orphanedFavorites = legacyApp.db
      .query("SELECT count(*) AS count FROM favorites WHERE saved_view_id = ?1")
      .get("legacy-null-view") as { count: number };
    expect(orphanedFavorites.count).toBe(0);
    const missing = await gql(legacyApp, `query { savedView(id: "legacy-null-view") { id } }`);
    expect(missing.data!.savedView).toBeNull();
  });
});
