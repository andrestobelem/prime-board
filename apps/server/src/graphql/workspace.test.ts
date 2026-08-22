// PRB-374: renombrado del Workspace y autorización global.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
let memberKey = "";
let workspaceId = "";

beforeAll(async () => {
  const initial = await gql(app, "{ workspace { id name urlKey } }");
  workspaceId = initial.data!.workspace.id as string;
  const actor = await gql(
    app,
    `mutation { actorCreate(input: { name: "workspace-member", type: AGENT }) { actor { id } } }`,
  );
  const actorId = actor.data!.actorCreate.actor.id as string;
  const key = await gql(
    app,
    `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "member key" }) { key } }`,
    { actorId },
  );
  memberKey = key.data!.apiKeyCreate.key as string;
});

afterAll(() => app.stop());

describe("workspaceUpdate", () => {
  it("permite a un Workspace Admin cambiar el nombre sin alterar urlKey o identidad", async () => {
    const updated = await gql(
      app,
      `mutation($name: String!) {
        workspaceUpdate(input: { name: $name }) {
          success workspace { id name urlKey createdAt }
        }
      }`,
      { name: "  Renamed Workspace  " },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.workspaceUpdate).toMatchObject({
      success: true,
      workspace: { id: workspaceId, name: "Renamed Workspace", urlKey: "prime-board" },
    });
  });

  it("rechaza a un actor member y no persiste el cambio", async () => {
    const denied = await gql(
      app,
      `mutation { workspaceUpdate(input: { name: "Unauthorized Workspace" }) { success } }`,
      {},
      memberKey,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const current = await gql(app, "{ workspace { id name urlKey } }");
    expect(current.data!.workspace).toMatchObject({
      id: workspaceId,
      name: "Renamed Workspace",
      urlKey: "prime-board",
    });
  });

  it("valida que el nombre no sea vacío", async () => {
    const invalid = await gql(
      app,
      `mutation { workspaceUpdate(input: { name: "   " }) { success } }`,
    );
    expect(invalid.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});

describe("Workspace GraphQL contract", () => {
  const lifecycleApp = createTestApp();
  let secondWorkspaceId = "";

  afterAll(() => lifecycleApp.stop());

  async function gqlWithWorkspace(
    query: string,
    workspaceId: string,
    apiKey = lifecycleApp.apiKey,
  ) {
    const response = await fetch(`${lifecycleApp.url}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
      },
      body: JSON.stringify({ query }),
    });
    return (await response.json()) as {
      data?: Record<string, any>;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };
  }

  it("lista el Workspace efectivo con Membership y compatibilidad legacy", async () => {
    const result = await gql(
      lifecycleApp,
      `{ workspaces { id urlKey role status isDefault } viewer { workspaces { id urlKey role status isDefault } } }`,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.workspaces).toHaveLength(1);
    expect(result.data?.workspaces[0]).toMatchObject({
      urlKey: "prime-board",
      role: "ADMIN",
      status: "ACTIVE",
      isDefault: true,
    });
    expect(result.data?.viewer.workspaces).toEqual(result.data?.workspaces);
  });

  it("crea el segundo Workspace con solo su bootstrap y lo selecciona por header", async () => {
    const created = await gql(
      lifecycleApp,
      `mutation { workspaceCreate(input: { name: "Second Workspace", urlKey: "second" }) { success workspace { id urlKey role status isDefault } } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data?.workspaceCreate.success).toBe(true);
    secondWorkspaceId = created.data?.workspaceCreate.workspace.id;
    expect(created.data?.workspaceCreate.workspace).toMatchObject({
      urlKey: "second",
      role: "ADMIN",
      status: "ACTIVE",
      isDefault: false,
    });
    expect(lifecycleApp.db.query("SELECT count(*) AS count FROM teams").get()).toEqual({
      count: 2,
    });
    expect(
      lifecycleApp.db
        .query("SELECT count(*) AS count FROM workflow_states WHERE workspace_id = ?1")
        .get(secondWorkspaceId),
    ).toEqual({ count: 5 });

    const selected = await gqlWithWorkspace(`{ workspace { id urlKey } }`, secondWorkspaceId);
    expect(selected.errors).toBeUndefined();
    expect(selected.data?.workspace).toEqual({ id: secondWorkspaceId, urlKey: "second" });

    const selectedTeams = await gqlWithWorkspace(`{ teams { key } }`, secondWorkspaceId);
    expect(selectedTeams.errors).toBeUndefined();
    expect(selectedTeams.data?.teams).toEqual([{ key: "WS" }]);

    const createdInSecond = await gqlWithWorkspace(
      `mutation { actorCreate(input: { name: "second-member", type: AGENT }) { success actor { id } } }`,
      secondWorkspaceId,
    );
    expect(createdInSecond.errors).toBeUndefined();
    const secondActors = await gqlWithWorkspace(`{ actors { name } }`, secondWorkspaceId);
    expect(secondActors.errors).toBeUndefined();
    expect(secondActors.data?.actors.map((actor: { name: string }) => actor.name)).toContain(
      "second-member",
    );

    const updated = await gqlWithWorkspace(
      `mutation { workspaceUpdate(input: { name: "Renamed Second" }) { workspace { id name urlKey } } }`,
      secondWorkspaceId,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.workspaceUpdate.workspace).toMatchObject({
      id: secondWorkspaceId,
      name: "Renamed Second",
      urlKey: "second",
    });

    const adminActor = lifecycleApp.db
      .query("SELECT id FROM actors WHERE name = 'admin'")
      .get() as {
      id: string;
    };
    lifecycleApp.db
      .query(
        "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ?1 AND actor_id = ?2",
      )
      .run(secondWorkspaceId, adminActor.id);
    const roleDenied = await gqlWithWorkspace(
      `mutation { teamCreate(input: { name: "Not allowed", key: "NOPE" }) { success } }`,
      secondWorkspaceId,
    );
    expect(roleDenied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const legacy = await gql(lifecycleApp, `{ workspace { id name urlKey } }`);
    expect(legacy.data?.workspace).toMatchObject({ urlKey: "prime-board", name: "workspace" });
  });

  it("rechaza seleccionar un Workspace sin grant", async () => {
    const actor = await gql(
      lifecycleApp,
      `mutation { actorCreate(input: { name: "scoped-member", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data?.actorCreate.actor.id;
    const key = await gql(
      lifecycleApp,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "scoped key" }) { key } }`,
      { actorId },
    );
    const denied = await gqlWithWorkspace(
      `{ workspace { id } }`,
      secondWorkspaceId,
      key.data?.apiKeyCreate.key,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });
});

describe("Local multi-Workspace selection", () => {
  const localApp = createTestApp(undefined, "local");

  afterAll(() => localApp.stop());

  it("uses the local Workspace selection without an API key", async () => {
    const created = await gql(
      localApp,
      `mutation { workspaceCreate(input: { name: "Local Second", urlKey: "local-second" }) { workspace { id urlKey } } }`,
      {},
      null,
    );
    expect(created.errors).toBeUndefined();
    const secondId = created.data?.workspaceCreate.workspace.id as string;
    const selected = await gql(localApp, `{ workspace { id urlKey } }`, {}, null, secondId);
    expect(selected.errors).toBeUndefined();
    expect(selected.data?.workspace).toEqual({ id: secondId, urlKey: "local-second" });
  });
});
