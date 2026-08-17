// PRB-268: favoritos privados, ordenados y round-trip de recursos.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let otherKey: string;
let projectId: string;
let otherProjectId: string;
let workspaceViewId: string;
let adminPersonalViewId: string;
let otherPersonalViewId: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id } }`);
  const teamId = team.data!.team.id;
  const projects = await Promise.all(
    ["Favorite project", "Other project"].map((name) =>
      gql(
        app,
        `mutation($team: ID!, $name: String!) { projectCreate(input: { name: $name, teamIds: [$team] }) { project { id } } }`,
        { team: teamId, name },
      ),
    ),
  );
  projectId = projects[0]!.data!.projectCreate.project.id;
  otherProjectId = projects[1]!.data!.projectCreate.project.id;

  const views = await Promise.all([
    gql(
      app,
      `mutation { savedViewCreate(input: { name: "Workspace view", scope: WORKSPACE }) { savedView { id } } }`,
    ),
    gql(
      app,
      `mutation { savedViewCreate(input: { name: "Admin personal", scope: PERSONAL }) { savedView { id } } }`,
    ),
  ]);
  workspaceViewId = views[0]!.data!.savedViewCreate.savedView.id;
  adminPersonalViewId = views[1]!.data!.savedViewCreate.savedView.id;

  const actor = await gql(
    app,
    `mutation { actorCreate(input: { name: "favorites-agent", type: AGENT }) { actor { id } } }`,
  );
  const key = await gql(
    app,
    `mutation($actor: ID!) { apiKeyCreate(input: { actorId: $actor, name: "favorites key" }) { key } }`,
    { actor: actor.data!.actorCreate.actor.id },
  );
  otherKey = key.data!.apiKeyCreate.key;
  const otherView = await gql(
    app,
    `mutation { savedViewCreate(input: { name: "Other personal", scope: PERSONAL }) { savedView { id } } }`,
    {},
    otherKey,
  );
  otherPersonalViewId = otherView.data!.savedViewCreate.savedView.id;
});

afterAll(() => app.stop());

const errors = (result: { errors?: Array<{ extensions?: { code?: string } }> }) =>
  result.errors?.map((error) => error.extensions?.code);

async function list(apiKey = app.apiKey) {
  const result = await gql(
    app,
    `{ favorites { id position project { id name archivedAt } savedView { id name archivedAt } } }`,
    {},
    apiKey,
  );
  expect(result.errors).toBeUndefined();
  return result.data!.favorites as Array<any>;
}

describe("favoritos por actor", () => {
  it("agrega de forma idempotente y cada actor solo ve los propios", async () => {
    const invalid = await gql(
      app,
      `mutation($project: ID!, $view: ID!) { favoriteCreate(input: { projectId: $project, savedViewId: $view }) { favorite { id } } }`,
      { project: projectId, view: workspaceViewId },
    );
    expect(errors(invalid)).toEqual(["VALIDATION_FAILED"]);
    const first = await gql(
      app,
      `mutation($project: ID!) { favoriteCreate(input: { projectId: $project }) { favorite { id position project { id } } } }`,
      { project: projectId },
    );
    expect(first.errors).toBeUndefined();
    const duplicate = await gql(
      app,
      `mutation($project: ID!) { favoriteCreate(input: { projectId: $project }) { favorite { id } } }`,
      { project: projectId },
    );
    expect(duplicate.errors).toBeUndefined();
    expect(duplicate.data!.favoriteCreate.favorite.id).toBe(first.data!.favoriteCreate.favorite.id);

    const workspace = await gql(
      app,
      `mutation($view: ID!) { favoriteCreate(input: { savedViewId: $view }) { favorite { id } } }`,
      { view: workspaceViewId },
    );
    expect(workspace.errors).toBeUndefined();
    const adminPersonal = await gql(
      app,
      `mutation($view: ID!) { favoriteCreate(input: { savedViewId: $view }) { favorite { id } } }`,
      { view: adminPersonalViewId },
    );
    expect(adminPersonal.errors).toBeUndefined();

    const own = await list();
    expect(own.map((favorite) => favorite.project?.id ?? favorite.savedView?.id)).toEqual([
      projectId,
      workspaceViewId,
      adminPersonalViewId,
    ]);
    expect(
      (await list(otherKey)).map((favorite) => favorite.project?.id ?? favorite.savedView?.id),
    ).toEqual([]);

    const forbidden = await gql(
      app,
      `mutation($view: ID!) { favoriteCreate(input: { savedViewId: $view }) { favorite { id } } }`,
      { view: adminPersonalViewId },
      otherKey,
    );
    expect(errors(forbidden)).toEqual(["NOT_FOUND"]);
    const other = await gql(
      app,
      `mutation($project: ID!) {
        favoriteCreate(input: { projectId: $project }) { favorite { id } }
      }`,
      { project: otherProjectId },
      otherKey,
    );
    expect(other.errors).toBeUndefined();
    const otherPersonal = await gql(
      app,
      `mutation($view: ID!) { favoriteCreate(input: { savedViewId: $view }) { favorite { id } } }`,
      { view: otherPersonalViewId },
      otherKey,
    );
    expect(otherPersonal.errors).toBeUndefined();
    expect(
      (await list(otherKey)).map((favorite) => favorite.project?.id ?? favorite.savedView?.id),
    ).toEqual([otherProjectId, otherPersonalViewId]);
  });

  it("reordena, no permite mutar otro actor y elimina de forma idempotente", async () => {
    const own = await list();
    const last = own[2]!;
    const reordered = await gql(
      app,
      `mutation($id: ID!) { favoriteReorder(id: $id, position: 0) { favorite { id position } } }`,
      { id: last.id },
    );
    expect(reordered.errors).toBeUndefined();
    expect((await list())[0]!.id).toBe(last.id);

    const otherFavorite = (await list(otherKey))[0]!;
    const forbidden = await gql(app, `mutation($id: ID!) { favoriteDelete(id: $id) { success } }`, {
      id: otherFavorite.id,
    });
    expect(errors(forbidden)).toEqual(["NOT_FOUND"]);
    expect((await list(otherKey)).map((favorite) => favorite.id)).toContain(otherFavorite.id);

    const removed = await gql(app, `mutation($id: ID!) { favoriteDelete(id: $id) { success } }`, {
      id: last.id,
    });
    expect(removed.errors).toBeUndefined();
    const repeated = await gql(app, `mutation($id: ID!) { favoriteDelete(id: $id) { success } }`, {
      id: last.id,
    });
    expect(repeated.errors).toBeUndefined();
    expect(repeated.data!.favoriteDelete.success).toBe(true);
  });

  it("oculta favoritos de recursos archivados y las FK limpian vistas borradas", async () => {
    const projectFavorite = await gql(
      app,
      `mutation($project: ID!) { favoriteCreate(input: { projectId: $project }) { favorite { id } } }`,
      { project: projectId },
    );
    expect(projectFavorite.errors).toBeUndefined();
    await gql(app, `mutation($id: ID!) { projectArchive(id: $id) { success } }`, { id: projectId });
    expect((await list()).some((favorite) => favorite.project?.id === projectId)).toBe(false);
    await gql(app, `mutation($id: ID!) { projectUnarchive(id: $id) { success } }`, {
      id: projectId,
    });
    expect((await list()).some((favorite) => favorite.project?.id === projectId)).toBe(true);

    const viewFavorite = await gql(
      app,
      `mutation($view: ID!) { favoriteCreate(input: { savedViewId: $view }) { favorite { id } } }`,
      { view: workspaceViewId },
    );
    expect(viewFavorite.errors).toBeUndefined();
    await gql(
      app,
      `mutation($id: ID!) { savedViewUpdate(id: $id, input: { archived: true }) { success } }`,
      { id: workspaceViewId },
    );
    expect((await list()).some((favorite) => favorite.savedView?.id === workspaceViewId)).toBe(
      false,
    );
    await gql(
      app,
      `mutation($id: ID!) { savedViewUpdate(id: $id, input: { archived: false }) { success } }`,
      { id: workspaceViewId },
    );
    expect((await list()).some((favorite) => favorite.savedView?.id === workspaceViewId)).toBe(
      true,
    );
    await gql(app, `mutation($id: ID!) { savedViewDelete(id: $id) { success } }`, {
      id: workspaceViewId,
    });
    expect((await list()).some((favorite) => favorite.savedView?.id === workspaceViewId)).toBe(
      false,
    );
    const remaining = app.db
      .query("SELECT count(*) AS count FROM favorites WHERE saved_view_id = ?1")
      .get(workspaceViewId) as { count: number };
    expect(remaining.count).toBe(0);
  });
});
