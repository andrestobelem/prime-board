import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

async function createSecondWorkspace(testApp: TestApp, urlKey: string): Promise<string> {
  const created = await gql(
    testApp,
    `mutation($urlKey: String!) {
      workspaceCreate(input: { name: "Second Workspace", urlKey: $urlKey }) {
        workspace { id }
      }
    }`,
    { urlKey },
  );
  expect(created.errors).toBeUndefined();
  return created.data!.workspaceCreate.workspace.id as string;
}

function addActorToWorkspace(
  testApp: TestApp,
  workspaceId: string,
  actorId: string,
  keyId: string,
): void {
  const timestamp = new Date().toISOString();
  testApp.db
    .query(
      `INSERT INTO workspace_memberships
       (id, workspace_id, actor_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'member', 'active', ?4, ?4)`,
    )
    .run(crypto.randomUUID(), workspaceId, actorId, timestamp);
  testApp.db
    .query(
      `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
       VALUES (?1, ?2, 0, ?3)`,
    )
    .run(keyId, workspaceId, timestamp);
}

describe("actor operations and Workspace Context", () => {
  it("stores an invitation in the selected Workspace", async () => {
    const created = await gql(
      app,
      `mutation {
        workspaceCreate(input: { name: "Second Workspace", urlKey: "second-actor-context" }) {
          workspace { id }
        }
      }`,
    );
    expect(created.errors).toBeUndefined();
    const workspaceId = created.data!.workspaceCreate.workspace.id as string;

    const invited = await gql(
      app,
      `mutation {
        actorInvite(input: { email: "second@example.com", type: AGENT }) {
          invitation { id }
        }
      }`,
      {},
      app.apiKey,
      workspaceId,
    );

    expect(invited.errors).toBeUndefined();
    const invitationId = invited.data!.actorInvite.invitation.id as string;
    expect(
      (
        app.db
          .query("SELECT workspace_id FROM actor_invitations WHERE id = ?1")
          .get(invitationId) as { workspace_id: string }
      ).workspace_id,
    ).toBe(workspaceId);
  });

  it("accepts an invitation in the selected Workspace without a session", async () => {
    const isolated = createTestApp();
    try {
      const workspaceUrlKey = "second-accept-context";
      const workspaceId = await createSecondWorkspace(isolated, workspaceUrlKey);
      const invited = await gql(
        isolated,
        `mutation {
          actorInvite(input: { email: "accepted@example.com", type: AGENT }) {
            token invitation { id }
          }
        }`,
        {},
        isolated.apiKey,
        workspaceId,
      );
      expect(invited.errors).toBeUndefined();

      const accepted = await gql(
        isolated,
        `mutation($token: String!) {
          actorInvitationAccept(token: $token, input: { name: "accepted-agent" }) {
            actor { id name }
            invitation { id status }
            key
          }
        }`,
        { token: invited.data!.actorInvite.token },
        null,
        workspaceUrlKey,
      );

      expect(accepted.errors).toBeUndefined();
      const actorId = accepted.data!.actorInvitationAccept.actor.id as string;
      expect(
        (
          isolated.db
            .query(
              "SELECT status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2",
            )
            .get(workspaceId, actorId) as { status: string }
        ).status,
      ).toBe("active");
    } finally {
      isolated.stop();
    }
  });

  it("lists and revokes invitations only in the selected Workspace", async () => {
    const isolated = createTestApp();
    try {
      const firstWorkspace = (await gql(isolated, `{ workspace { id } }`)).data!.workspace
        .id as string;
      const firstInvite = await gql(
        isolated,
        `mutation {
          actorInvite(input: { email: "first@example.com", type: AGENT }) {
            invitation { id }
          }
        }`,
      );
      expect(firstInvite.errors).toBeUndefined();
      const firstInvitationId = firstInvite.data!.actorInvite.invitation.id as string;

      const secondWorkspace = await createSecondWorkspace(isolated, "second-list-context");
      const secondInvite = await gql(
        isolated,
        `mutation {
          actorInvite(input: { email: "first@example.com", type: AGENT }) {
            invitation { id }
          }
        }`,
        {},
        isolated.apiKey,
        secondWorkspace,
      );
      expect(secondInvite.errors).toBeUndefined();
      const secondInvitationId = secondInvite.data!.actorInvite.invitation.id as string;

      const listed = await gql(
        isolated,
        `{ actorInvitations { id email } }`,
        {},
        isolated.apiKey,
        secondWorkspace,
      );
      expect(listed.errors).toBeUndefined();
      expect(listed.data!.actorInvitations).toEqual([
        { id: secondInvitationId, email: "first@example.com" },
      ]);

      const wrongWorkspaceRevoke = await gql(
        isolated,
        `mutation($id: ID!) { actorInvitationRevoke(id: $id) { success } }`,
        { id: firstInvitationId },
        isolated.apiKey,
        secondWorkspace,
      );
      expect(wrongWorkspaceRevoke.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

      const firstStillPending = await gql(
        isolated,
        `{ actorInvitations { id status } }`,
        {},
        isolated.apiKey,
        firstWorkspace,
      );
      expect(firstStillPending.data!.actorInvitations).toContainEqual({
        id: firstInvitationId,
        status: "PENDING",
      });

      const revoked = await gql(
        isolated,
        `mutation($id: ID!) { actorInvitationRevoke(id: $id) { invitation { status } } }`,
        { id: secondInvitationId },
        isolated.apiKey,
        secondWorkspace,
      );
      expect(revoked.errors).toBeUndefined();
      expect(revoked.data!.actorInvitationRevoke.invitation.status).toBe("REVOKED");
    } finally {
      isolated.stop();
    }
  });

  it("changes only the selected Workspace membership and key grant", async () => {
    const isolated = createTestApp();
    try {
      const firstWorkspace = (await gql(isolated, `{ workspace { id } }`)).data!.workspace
        .id as string;
      const secondWorkspace = await createSecondWorkspace(isolated, "second-lifecycle-context");
      const adminId = (await gql(isolated, `{ viewer { id } }`)).data!.viewer.id as string;

      const created = await gql(
        isolated,
        `mutation {
          actorCreate(input: { name: "second-admin", type: AGENT }) { actor { id } }
        }`,
        {},
        isolated.apiKey,
        secondWorkspace,
      );
      expect(created.errors).toBeUndefined();
      const secondAdminId = created.data!.actorCreate.actor.id as string;
      const secondAdminKeyResult = await gql(
        isolated,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "second admin key" }) { key }
        }`,
        { actorId: secondAdminId },
        isolated.apiKey,
        secondWorkspace,
      );
      expect(secondAdminKeyResult.errors).toBeUndefined();
      const secondAdminKey = secondAdminKeyResult.data!.apiKeyCreate.key as string;
      isolated.db
        .query(
          "UPDATE workspace_memberships SET role = 'admin' WHERE workspace_id = ?1 AND actor_id = ?2",
        )
        .run(secondWorkspace, secondAdminId);

      const wrongWorkspaceActor = await gql(
        isolated,
        `mutation($id: ID!) { actorSuspend(id: $id) { actor { id } } }`,
        { id: secondAdminId },
        isolated.apiKey,
        firstWorkspace,
      );
      expect(wrongWorkspaceActor.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

      const suspended = await gql(
        isolated,
        `mutation($id: ID!) { actorSuspend(id: $id) { actor { id status } } }`,
        { id: adminId },
        secondAdminKey,
        secondWorkspace,
      );
      expect(suspended.errors).toBeUndefined();
      expect(suspended.data!.actorSuspend.actor).toEqual({ id: adminId, status: "SUSPENDED" });
      expect(
        (
          isolated.db
            .query(
              "SELECT status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2",
            )
            .get(firstWorkspace, adminId) as { status: string }
        ).status,
      ).toBe("active");
      expect(
        (
          isolated.db
            .query(
              "SELECT status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2",
            )
            .get(secondWorkspace, adminId) as { status: string }
        ).status,
      ).toBe("suspended");

      const firstViewer = await gql(isolated, `{ viewer { id status } }`, {}, isolated.apiKey);
      expect(firstViewer.errors).toBeUndefined();
      expect(firstViewer.data!.viewer).toEqual({ id: adminId, status: "ACTIVE" });
      const suspendedSecondViewer = await gql(
        isolated,
        `{ viewer { id } }`,
        {},
        isolated.apiKey,
        secondWorkspace,
      );
      expect(suspendedSecondViewer.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

      const reactivated = await gql(
        isolated,
        `mutation($id: ID!) { actorReactivate(id: $id) { actor { id status } } }`,
        { id: adminId },
        secondAdminKey,
        secondWorkspace,
      );
      expect(reactivated.errors).toBeUndefined();

      const revoked = await gql(
        isolated,
        `mutation($id: ID!) { actorRevoke(id: $id) { actor { id status } } }`,
        { id: adminId },
        secondAdminKey,
        secondWorkspace,
      );
      expect(revoked.errors).toBeUndefined();
      expect(revoked.data!.actorRevoke.actor).toEqual({ id: adminId, status: "LEFT" });
      const firstViewerAfterRevoke = await gql(
        isolated,
        `{ viewer { id status } }`,
        {},
        isolated.apiKey,
      );
      expect(firstViewerAfterRevoke.errors).toBeUndefined();
      expect(firstViewerAfterRevoke.data!.viewer).toEqual({ id: adminId, status: "ACTIVE" });
      const revokedSecondViewer = await gql(
        isolated,
        `{ viewer { id } }`,
        {},
        isolated.apiKey,
        secondWorkspace,
      );
      expect(revokedSecondViewer.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    } finally {
      isolated.stop();
    }
  });

  it("lets an actor leave only the selected Workspace", async () => {
    const isolated = createTestApp();
    try {
      const firstWorkspace = (await gql(isolated, `{ workspace { id } }`)).data!.workspace
        .id as string;
      const secondWorkspace = await createSecondWorkspace(isolated, "second-leave-context");
      const adminId = (await gql(isolated, `{ viewer { id } }`)).data!.viewer.id as string;

      const created = await gql(
        isolated,
        `mutation {
          actorCreate(input: { name: "second-workspace-admin", type: AGENT }) { actor { id } }
        }`,
        {},
        isolated.apiKey,
        secondWorkspace,
      );
      expect(created.errors).toBeUndefined();
      const secondAdminId = created.data!.actorCreate.actor.id as string;
      isolated.db
        .query(
          "UPDATE workspace_memberships SET role = 'admin' WHERE workspace_id = ?1 AND actor_id = ?2",
        )
        .run(secondWorkspace, secondAdminId);

      const left = await gql(
        isolated,
        `mutation { actorLeave { actor { id status } } }`,
        {},
        isolated.apiKey,
        secondWorkspace,
      );
      expect(left.errors).toBeUndefined();
      expect(left.data!.actorLeave.actor).toEqual({ id: adminId, status: "LEFT" });
      expect(
        (
          isolated.db
            .query(
              "SELECT status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2",
            )
            .get(firstWorkspace, adminId) as { status: string }
        ).status,
      ).toBe("active");
      expect(
        (
          isolated.db
            .query(
              "SELECT status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2",
            )
            .get(secondWorkspace, adminId) as { status: string }
        ).status,
      ).toBe("left");
      expect((await gql(isolated, `{ viewer { id status } }`)).errors).toBeUndefined();
      expect(
        (await gql(isolated, `{ viewer { id } }`, {}, isolated.apiKey, secondWorkspace)).errors?.[0]
          ?.extensions?.code,
      ).toBe("UNAUTHORIZED");
    } finally {
      isolated.stop();
    }
  });

  it("preserves an actor key granted to another Workspace", async () => {
    const isolated = createTestApp();
    try {
      const firstWorkspace = (await gql(isolated, `{ workspace { id } }`)).data!.workspace
        .id as string;
      const secondWorkspace = await createSecondWorkspace(isolated, "second-key-context");
      const created = await gql(
        isolated,
        `mutation {
          actorCreate(input: { name: "key-isolated-actor", type: AGENT }) { actor { id } }
        }`,
      );
      expect(created.errors).toBeUndefined();
      const actorId = created.data!.actorCreate.actor.id as string;
      const keyResult = await gql(
        isolated,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "key-isolated" }) { key apiKey { id } }
        }`,
        { actorId },
      );
      expect(keyResult.errors).toBeUndefined();
      const actorKey = keyResult.data!.apiKeyCreate.key as string;
      const actorKeyId = keyResult.data!.apiKeyCreate.apiKey.id as string;
      addActorToWorkspace(isolated, secondWorkspace, actorId, actorKeyId);

      const revoked = await gql(
        isolated,
        `mutation($id: ID!) { actorRevoke(id: $id) { actor { id status } } }`,
        { id: actorId },
        isolated.apiKey,
        secondWorkspace,
      );
      expect(revoked.errors).toBeUndefined();
      expect(revoked.data!.actorRevoke.actor).toEqual({ id: actorId, status: "LEFT" });
      expect(
        (
          isolated.db.query("SELECT revoked_at FROM api_keys WHERE id = ?1").get(actorKeyId) as {
            revoked_at: string | null;
          }
        ).revoked_at,
      ).toBeNull();
      expect(
        (await gql(isolated, `{ viewer { id } }`, {}, actorKey, firstWorkspace)).data!.viewer.id,
      ).toBe(actorId);
      expect(
        (await gql(isolated, `{ viewer { id } }`, {}, actorKey, secondWorkspace)).errors?.[0]
          ?.extensions?.code,
      ).toBe("UNAUTHORIZED");
    } finally {
      isolated.stop();
    }
  });
});
