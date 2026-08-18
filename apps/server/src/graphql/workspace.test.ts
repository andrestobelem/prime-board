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
