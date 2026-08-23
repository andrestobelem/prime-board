import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let limitedKey: string;
let personalViewId: string;
let workspaceViewId: string;
let projectId: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id } }`);
  const teamId = team.data!.team.id as string;
  const viewer = await gql(app, `{ viewer { id } }`);
  const actorId = viewer.data!.viewer.id as string;

  const project = await gql(
    app,
    `mutation($teamId: ID!) { projectCreate(input: { name: "Scoped project", teamIds: [$teamId] }) { project { id } } }`,
    { teamId },
  );
  projectId = project.data!.projectCreate.project.id as string;

  const personal = await gql(
    app,
    `mutation { savedViewCreate(input: { name: "Personal secret", scope: PERSONAL, filter: { secret: "outside-team" } }) { savedView { id } } }`,
  );
  personalViewId = personal.data!.savedViewCreate.savedView.id as string;
  const workspace = await gql(
    app,
    `mutation { savedViewCreate(input: { name: "Workspace secret", scope: WORKSPACE, filter: { secret: "outside-team" } }) { savedView { id } } }`,
  );
  workspaceViewId = workspace.data!.savedViewCreate.savedView.id as string;

  const key = await gql(
    app,
    `mutation($actorId: ID!, $teamId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "limited saved views", scopes: [WRITE], teamIds: [$teamId] }) { key } }`,
    { actorId, teamId },
  );
  limitedKey = key.data!.apiKeyCreate.key as string;
});

afterAll(() => app.stop());

describe("autorización de saved views y favorites con límites de Team", () => {
  it("bloquea vistas PERSONAL y WORKSPACE en consultas directas y mutaciones", async () => {
    for (const id of [personalViewId, workspaceViewId]) {
      const query = await gql(
        app,
        `query($id: ID!) { savedView(id: $id) { id filter } }`,
        { id },
        limitedKey,
      );
      expect(query.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
      expect(query.data?.savedView).toBeNull();

      for (const mutation of [
        `mutation($id: ID!) { savedViewUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
        `mutation($id: ID!) { savedViewDuplicate(id: $id) { success } }`,
        `mutation($id: ID!) { savedViewDelete(id: $id) { success } }`,
      ]) {
        const denied = await gql(app, mutation, { id }, limitedKey);
        expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
      }
    }
  });

  it("permite eliminar y reordenar un favorite de un Project autorizado", async () => {
    const created = await gql(
      app,
      `mutation($projectId: ID!) { favoriteCreate(input: { projectId: $projectId }) { favorite { id } } }`,
      { projectId },
      limitedKey,
    );
    expect(created.errors).toBeUndefined();
    const favoriteId = created.data!.favoriteCreate.favorite.id as string;

    const reordered = await gql(
      app,
      `mutation($id: ID!) { favoriteReorder(id: $id, position: 0) { favorite { id position } } }`,
      { id: favoriteId },
      limitedKey,
    );
    expect(reordered.errors).toBeUndefined();
    expect(reordered.data!.favoriteReorder.favorite.id).toBe(favoriteId);

    const deleted = await gql(
      app,
      `mutation($id: ID!) { favoriteDelete(id: $id) { success } }`,
      { id: favoriteId },
      limitedKey,
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data!.favoriteDelete.success).toBe(true);
  });
});
