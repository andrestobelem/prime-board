import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("modern Workspace GraphQL contract", () => {
  it("publishes workspaceId on every scoped resource type", async () => {
    const result = await gql(app, `{ __schema { types { name fields { name } } } }`);
    expect(result.errors).toBeUndefined();
    for (const typeName of ["Actor", "ApiKey", "ActorInvitation", "Team", "Label", "Webhook"]) {
      const type = result.data?.__schema.types.find(
        (candidate: { name: string }) => candidate.name === typeName,
      );
      expect(type?.fields.map((field: { name: string }) => field.name)).toContain("workspaceId");
    }
  });

  it("returns the selected effective Workspace for all scoped resources", async () => {
    const created = await gql(
      app,
      `mutation {
        workspaceCreate(input: { name: "Contract Workspace", urlKey: "contract" }) {
          workspace { id }
        }
      }`,
    );
    expect(created.errors).toBeUndefined();
    const secondWorkspaceId = created.data?.workspaceCreate.workspace.id;
    expect(typeof secondWorkspaceId).toBe("string");
    if (typeof secondWorkspaceId !== "string") throw new Error("Workspace was not created");

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "contract-agent", type: AGENT }) { actor { id } } }`,
      {},
      app.apiKey,
      secondWorkspaceId,
    );
    expect(actor.errors).toBeUndefined();
    const actorId = actor.data?.actorCreate.actor.id;
    expect(typeof actorId).toBe("string");
    if (typeof actorId !== "string") throw new Error("Actor was not created");

    const key = await gql(
      app,
      `mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "contract-key" }) {
          apiKey { workspaceId }
        }
      }`,
      { actorId },
      app.apiKey,
      secondWorkspaceId,
    );
    expect(key.errors).toBeUndefined();
    expect(key.data?.apiKeyCreate.apiKey.workspaceId).toBe(secondWorkspaceId);

    const label = await gql(
      app,
      `mutation { labelCreate(input: { name: "contract-label" }) { label { workspaceId } } }`,
      {},
      app.apiKey,
      secondWorkspaceId,
    );
    expect(label.errors).toBeUndefined();

    const invitation = await gql(
      app,
      `mutation { actorInvite(input: { email: "contract@example.com", type: AGENT }) { invitation { workspaceId } } }`,
      {},
      app.apiKey,
      secondWorkspaceId,
    );
    expect(invitation.errors).toBeUndefined();

    const webhook = await gql(
      app,
      `mutation { webhookCreate(input: { url: "https://contract.example/hook" }) { webhook { workspaceId } } }`,
      {},
      app.apiKey,
      secondWorkspaceId,
    );
    expect(webhook.errors).toBeUndefined();

    const selected = await gql(
      app,
      `{ viewer { workspaceId apiKeys { workspaceId } }
         actors { workspaceId }
         teams { workspaceId }
         labels { workspaceId }
         actorInvitations(includeRevoked: true) { workspaceId }
         webhooks { workspaceId } }`,
      {},
      app.apiKey,
      secondWorkspaceId,
    );
    expect(selected.errors).toBeUndefined();
    expect(selected.data?.viewer.workspaceId).toBe(secondWorkspaceId);
    expect(selected.data?.viewer.apiKeys).not.toHaveLength(0);
    expect(
      selected.data?.viewer.apiKeys.every(
        (item: { workspaceId: string }) => item.workspaceId === secondWorkspaceId,
      ),
    ).toBe(true);
    for (const collection of ["actors", "teams", "labels", "actorInvitations", "webhooks"]) {
      expect(selected.data?.[collection].length).toBeGreaterThan(0);
      expect(
        selected.data?.[collection].every(
          (item: { workspaceId: string }) => item.workspaceId === secondWorkspaceId,
        ),
      ).toBe(true);
    }
  });
});
