// PRB-514: invitaciones y lifecycle de actores aislados por Workspace.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

function addMembership(actorId: string, workspaceId: string, id: string): void {
  const timestamp = new Date().toISOString();
  app.db
    .query(
      `INSERT INTO workspace_memberships
       (id, workspace_id, actor_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'member', 'active', ?4, ?4)`,
    )
    .run(id, workspaceId, actorId, timestamp);
}

describe("actor Workspace isolation", () => {
  it("scopes invitations, acceptance, and invitation keys", async () => {
    const createdWorkspace = await gql(
      app,
      `mutation {
        workspaceCreate(input: { name: "Actor isolation", urlKey: "actor-isolation" }) {
          workspace { id urlKey }
        }
      }`,
    );
    expect(createdWorkspace.errors).toBeUndefined();
    const workspaceBId = createdWorkspace.data!.workspaceCreate.workspace.id as string;

    const inviteA = await gql(
      app,
      `mutation { actorInvite(input: { email: "same@example.com", type: AGENT }) {
        token invitation { id status }
      } }`,
      {},
      app.apiKey,
      "prime-board",
    );
    const inviteB = await gql(
      app,
      `mutation { actorInvite(input: { email: "same@example.com", type: AGENT }) {
        token invitation { id status }
      } }`,
      {},
      app.apiKey,
      "actor-isolation",
    );
    expect(inviteA.errors).toBeUndefined();
    expect(inviteB.errors).toBeUndefined();
    const invitationAId = inviteA.data!.actorInvite.invitation.id as string;
    const invitationBId = inviteB.data!.actorInvite.invitation.id as string;
    const tokenA = inviteA.data!.actorInvite.token as string;
    expect(invitationAId).not.toBe(invitationBId);
    expect(
      app.db.query("SELECT workspace_id FROM actor_invitations WHERE id = ?1").get(invitationAId),
    ).toEqual({ workspace_id: expect.any(String) });
    expect(
      app.db.query("SELECT workspace_id FROM actor_invitations WHERE id = ?1").get(invitationBId),
    ).toEqual({ workspace_id: workspaceBId });

    const listedA = await gql(app, `{ actorInvitations { id } }`, {}, app.apiKey, "prime-board");
    const listedB = await gql(
      app,
      `{ actorInvitations { id } }`,
      {},
      app.apiKey,
      "actor-isolation",
    );
    expect(listedA.data!.actorInvitations.map((row: { id: string }) => row.id)).toEqual([
      invitationAId,
    ]);
    expect(listedB.data!.actorInvitations.map((row: { id: string }) => row.id)).toEqual([
      invitationBId,
    ]);

    const wrongRevoke = await gql(
      app,
      `mutation($id: ID!) { actorInvitationRevoke(id: $id) { success } }`,
      { id: invitationBId },
      app.apiKey,
      "prime-board",
    );
    expect(wrongRevoke.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(
      app.db.query("SELECT status FROM actor_invitations WHERE id = ?1").get(invitationBId),
    ).toEqual({ status: "pending" });

    const wrongAccept = await gql(
      app,
      `mutation($token: String!) { actorInvitationAccept(token: $token, input: { name: "wrong" }) { key } }`,
      { token: tokenA },
      null,
      "actor-isolation",
    );
    expect(wrongAccept.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(
      app.db.query("SELECT status FROM actor_invitations WHERE id = ?1").get(invitationAId),
    ).toEqual({ status: "pending" });

    const accepted = await gql(
      app,
      `mutation($token: String!) { actorInvitationAccept(token: $token, input: { name: "isolated-agent" }) {
        actor { id } invitation { id status } key
      } }`,
      { token: tokenA },
      null,
      "prime-board",
    );
    expect(accepted.errors).toBeUndefined();
    const actorId = accepted.data!.actorInvitationAccept.actor.id as string;
    const invitationKey = accepted.data!.actorInvitationAccept.key as string;
    expect(accepted.data!.actorInvitationAccept.invitation).toMatchObject({
      id: invitationAId,
      status: "ACCEPTED",
    });
    expect(
      app.db
        .query(
          "SELECT workspace_id, status FROM workspace_memberships WHERE actor_id = ?1 ORDER BY workspace_id",
        )
        .all(actorId),
    ).toEqual([{ workspace_id: expect.any(String), status: "active" }]);

    const viewerA = await gql(app, `{ viewer { id } }`, {}, invitationKey, "prime-board");
    const viewerB = await gql(app, `{ viewer { id } }`, {}, invitationKey, "actor-isolation");
    expect(viewerA.data!.viewer.id).toBe(actorId);
    expect(viewerB.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("changes lifecycle state and key access only in the selected Workspace", async () => {
    const createdWorkspace = await gql(
      app,
      `mutation {
        workspaceCreate(input: { name: "Lifecycle isolation", urlKey: "lifecycle-isolation" }) {
          workspace { id }
        }
      }`,
    );
    expect(createdWorkspace.errors).toBeUndefined();
    const workspaceBId = createdWorkspace.data!.workspaceCreate.workspace.id as string;

    const created = await gql(
      app,
      `mutation { actorCreate(input: { name: "shared-lifecycle-agent", type: AGENT }) { actor { id } } }`,
      {},
      app.apiKey,
      "prime-board",
    );
    expect(created.errors).toBeUndefined();
    const actorId = created.data!.actorCreate.actor.id as string;
    addMembership(actorId, workspaceBId, "shared-lifecycle-membership");

    const keyResult = await gql(
      app,
      `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "shared key" }) { key apiKey { id } } }`,
      { id: actorId },
      app.apiKey,
      "prime-board",
    );
    expect(keyResult.errors).toBeUndefined();
    const key = keyResult.data!.apiKeyCreate.key as string;
    const keyId = keyResult.data!.apiKeyCreate.apiKey.id as string;
    app.db
      .query(
        `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
         VALUES (?1, ?2, 0, ?3)`,
      )
      .run(keyId, workspaceBId, new Date().toISOString());

    const suspended = await gql(
      app,
      `mutation($id: ID!) { actorSuspend(id: $id) { actor { id status } } }`,
      { id: actorId },
      app.apiKey,
      "lifecycle-isolation",
    );
    expect(suspended.errors).toBeUndefined();
    expect(suspended.data!.actorSuspend.actor).toEqual({ id: actorId, status: "SUSPENDED" });
    expect(
      app.db
        .query(
          "SELECT workspace_id, status FROM workspace_memberships WHERE actor_id = ?1 ORDER BY workspace_id",
        )
        .all(actorId),
    ).toEqual([
      { workspace_id: expect.any(String), status: "active" },
      { workspace_id: workspaceBId, status: "suspended" },
    ]);
    expect((await gql(app, `{ viewer { id } }`, {}, key, "prime-board")).data!.viewer.id).toBe(
      actorId,
    );
    expect(
      (await gql(app, `{ viewer { id } }`, {}, key, "lifecycle-isolation")).errors?.[0]?.extensions
        ?.code,
    ).toBe("UNAUTHORIZED");

    const reactivated = await gql(
      app,
      `mutation($id: ID!) { actorReactivate(id: $id) { actor { id status } } }`,
      { id: actorId },
      app.apiKey,
      "lifecycle-isolation",
    );
    expect(reactivated.errors).toBeUndefined();
    expect(
      (await gql(app, `{ viewer { id } }`, {}, key, "lifecycle-isolation")).data!.viewer.id,
    ).toBe(actorId);

    const revoked = await gql(
      app,
      `mutation($id: ID!) { actorRevoke(id: $id) { actor { id status } } }`,
      { id: actorId },
      app.apiKey,
      "prime-board",
    );
    expect(revoked.errors).toBeUndefined();
    expect(revoked.data!.actorRevoke.actor).toEqual({ id: actorId, status: "LEFT" });
    expect(
      (await gql(app, `{ viewer { id } }`, {}, key, "prime-board")).errors?.[0]?.extensions?.code,
    ).toBe("UNAUTHORIZED");
    expect(
      (await gql(app, `{ viewer { id } }`, {}, key, "lifecycle-isolation")).data!.viewer.id,
    ).toBe(actorId);
    expect(app.db.query("SELECT revoked_at FROM api_keys WHERE id = ?1").get(keyId)).toEqual({
      revoked_at: null,
    });
    expect(
      app.db
        .query(
          "SELECT workspace_id FROM api_key_workspaces WHERE api_key_id = ?1 ORDER BY workspace_id",
        )
        .all(keyId),
    ).toEqual([{ workspace_id: workspaceBId }]);

    const leaving = await gql(
      app,
      `mutation { actorCreate(input: { name: "leaving-lifecycle-agent", type: AGENT }) { actor { id } } }`,
      {},
      app.apiKey,
      "prime-board",
    );
    const leavingId = leaving.data!.actorCreate.actor.id as string;
    addMembership(leavingId, workspaceBId, "leaving-lifecycle-membership");
    const leaveKey = await gql(
      app,
      `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "leave key" }) { key } }`,
      { id: leavingId },
      app.apiKey,
      "lifecycle-isolation",
    );
    const left = await gql(
      app,
      `mutation { actorLeave { actor { id status } } }`,
      {},
      leaveKey.data!.apiKeyCreate.key,
      "lifecycle-isolation",
    );
    expect(left.errors).toBeUndefined();
    expect(left.data!.actorLeave.actor).toEqual({ id: leavingId, status: "LEFT" });
    expect(
      app.db
        .query(
          "SELECT workspace_id, status FROM workspace_memberships WHERE actor_id = ?1 ORDER BY workspace_id",
        )
        .all(leavingId),
    ).toEqual([
      { workspace_id: expect.any(String), status: "active" },
      { workspace_id: workspaceBId, status: "left" },
    ]);
  });

  it("protects the last active admin in each Workspace", async () => {
    const isolated = createTestApp();
    try {
      const created = await gql(
        isolated,
        `mutation { workspaceCreate(input: { name: "Admin guard", urlKey: "admin-guard" }) {
          workspace { id }
        } }`,
      );
      expect(created.errors).toBeUndefined();
      const workspaceId = created.data!.workspaceCreate.workspace.id as string;
      const adminId = (await gql(isolated, `{ viewer { id } }`)).data!.viewer.id as string;

      for (const mutation of ["actorSuspend", "actorRevoke"]) {
        const denied = await gql(
          isolated,
          `mutation($id: ID!) { ${mutation}(id: $id) { actor { id } } }`,
          { id: adminId },
          isolated.apiKey,
          workspaceId,
        );
        expect(denied.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
      }
      const leave = await gql(
        isolated,
        `mutation { actorLeave { actor { id } } }`,
        {},
        isolated.apiKey,
        workspaceId,
      );
      expect(leave.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
      expect(
        isolated.db
          .query(
            "SELECT role, status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2",
          )
          .get(workspaceId, adminId),
      ).toEqual({ role: "admin", status: "active" });
    } finally {
      isolated.stop();
    }
  });

  it("reuses a global Actor identity across Workspace invitations", async () => {
    const createdWorkspace = await gql(
      app,
      `mutation {
        workspaceCreate(input: { name: "Identity reuse", urlKey: "identity-reuse" }) {
          workspace { id }
        }
      }`,
    );
    expect(createdWorkspace.errors).toBeUndefined();
    const workspaceBId = createdWorkspace.data!.workspaceCreate.workspace.id as string;

    const firstInvite = await gql(
      app,
      `mutation { actorInvite(input: { email: "global@example.com", type: AGENT }) {
        token invitation { id }
      } }`,
      {},
      app.apiKey,
      "prime-board",
    );
    expect(firstInvite.errors).toBeUndefined();
    const firstAccepted = await gql(
      app,
      `mutation($token: String!) { actorInvitationAccept(token: $token, input: { name: "global-agent" }) {
        actor { id } key
      } }`,
      { token: firstInvite.data!.actorInvite.token },
      null,
      "prime-board",
    );
    expect(firstAccepted.errors).toBeUndefined();
    const actorId = firstAccepted.data!.actorInvitationAccept.actor.id as string;

    const secondInvite = await gql(
      app,
      `mutation { actorInvite(input: { email: "GLOBAL@example.com", type: AGENT }) {
        token invitation { id }
      } }`,
      {},
      app.apiKey,
      workspaceBId,
    );
    expect(secondInvite.errors).toBeUndefined();
    const secondAccepted = await gql(
      app,
      `mutation($token: String!) { actorInvitationAccept(token: $token, input: { name: "different-name" }) {
        actor { id name } key
      } }`,
      { token: secondInvite.data!.actorInvite.token },
      null,
      workspaceBId,
    );
    expect(secondAccepted.errors).toBeUndefined();
    expect(secondAccepted.data!.actorInvitationAccept.actor).toEqual({
      id: actorId,
      name: "global-agent",
    });
    expect(
      app.db
        .query("SELECT count(*) AS count FROM actors WHERE lower(email) = 'global@example.com'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      app.db
        .query(
          "SELECT workspace_id, status FROM workspace_memberships WHERE actor_id = ?1 ORDER BY workspace_id",
        )
        .all(actorId),
    ).toEqual([
      { workspace_id: expect.any(String), status: "active" },
      { workspace_id: workspaceBId, status: "active" },
    ]);
  });
});
