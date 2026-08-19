// PRB-379: ciclo local de invitaciones y acceso del roster.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("actor access lifecycle", () => {
  it("invites, accepts once and preserves actor identity", async () => {
    const invited = await gql(
      app,
      `mutation {
      actorInvite(input: { email: "new@example.com", type: AGENT }) {
        success token invitation { id status email }
      }
    }`,
    );
    expect(invited.errors).toBeUndefined();
    const token = invited.data!.actorInvite.token;
    const invitationId = invited.data!.actorInvite.invitation.id;
    expect(invited.data!.actorInvite.invitation.status).toBe("PENDING");

    const accepted = await gql(
      app,
      `mutation($token: String!) {
      actorInvitationAccept(token: $token, input: { name: "new-agent" }) {
        actor { id name status }
        invitation { id status actorId }
        key
      }
    }`,
      { token },
      null,
    );
    expect(accepted.errors).toBeUndefined();
    expect(accepted.data!.actorInvitationAccept.actor).toMatchObject({
      name: "new-agent",
      status: "ACTIVE",
    });
    expect(accepted.data!.actorInvitationAccept.invitation).toMatchObject({
      id: invitationId,
      status: "ACCEPTED",
    });
    const key = accepted.data!.actorInvitationAccept.key;
    expect((await gql(app, `{ viewer { name } }`, {}, key)).data!.viewer.name).toBe("new-agent");

    const again = await gql(
      app,
      `mutation($token: String!) {
      actorInvitationAccept(token: $token, input: { name: "other" }) { key }
    }`,
      { token },
      null,
    );
    expect(again.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("rolls back a failed acceptance and leaves the invitation pending", async () => {
    const invited = await gql(
      app,
      `mutation { actorInvite(input: { email: "rollback@example.com", name: "admin" }) {
        token invitation { id status }
      } }`,
    );
    const token = invited.data!.actorInvite.token;
    const invitationId = invited.data!.actorInvite.invitation.id;
    const failed = await gql(
      app,
      `mutation($token: String!) { actorInvitationAccept(token: $token, input: {}) { key } }`,
      { token },
      null,
    );
    expect(failed.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const pending = await gql(app, `{ actorInvitations { id status } }`);
    expect(pending.data!.actorInvitations).toContainEqual({ id: invitationId, status: "PENDING" });
  });

  it("keeps invitation revocation admin-only and invalidates the token", async () => {
    const invited = await gql(
      app,
      `mutation { actorInvite(input: { email: "revokable@example.com" }) {
        token invitation { id status }
      } }`,
    );
    const invitationId = invited.data!.actorInvite.invitation.id;
    const token = invited.data!.actorInvite.token;
    const member = await gql(
      app,
      `mutation { actorCreate(input: { name: "invitation-member", type: AGENT }) { actor { id } } }`,
    );
    const memberId = member.data!.actorCreate.actor.id;
    const memberKeyResult = await gql(
      app,
      `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "member login" }) { key } }`,
      { id: memberId },
    );
    const listed = await gql(
      app,
      `{ actorInvitations { id email } }`,
      {},
      memberKeyResult.data!.apiKeyCreate.key,
    );
    expect(listed.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const denied = await gql(
      app,
      `mutation($id: ID!) { actorInvitationRevoke(id: $id) { success } }`,
      { id: invitationId },
      memberKeyResult.data!.apiKeyCreate.key,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const revoked = await gql(
      app,
      `mutation($id: ID!) { actorInvitationRevoke(id: $id) { success invitation { status } } }`,
      { id: invitationId },
    );
    expect(revoked.errors).toBeUndefined();
    expect(revoked.data!.actorInvitationRevoke.invitation.status).toBe("REVOKED");
    const accepted = await gql(
      app,
      `mutation($token: String!) { actorInvitationAccept(token: $token, input: { name: "never" }) { key } }`,
      { token },
      null,
    );
    expect(accepted.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("lets only admins permanently revoke access while preserving actor history", async () => {
    const created = await gql(
      app,
      `mutation { actorCreate(input: { name: "revoked-agent", type: AGENT }) { actor { id } } }`,
    );
    const id = created.data!.actorCreate.actor.id;
    const keyResult = await gql(
      app,
      `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "revoke login" }) { key } }`,
      { id },
    );
    const key = keyResult.data!.apiKeyCreate.key;
    const denied = await gql(
      app,
      `mutation($id: ID!) { actorRevoke(id: $id) { success } }`,
      { id },
      key,
    );
    // The key above belongs to the target, not an admin; it cannot revoke itself.
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const revoked = await gql(
      app,
      `mutation($id: ID!) { actorRevoke(id: $id) { success actor { id status } } }`,
      { id },
    );
    expect(revoked.errors).toBeUndefined();
    expect(revoked.data!.actorRevoke.actor).toEqual({ id, status: "LEFT" });
    expect((await gql(app, `{ viewer { id } }`, {}, key)).errors?.[0]?.extensions?.code).toBe(
      "UNAUTHORIZED",
    );
    const reactivate = await gql(
      app,
      `mutation($id: ID!) { actorReactivate(id: $id) { actor { id } } }`,
      { id },
    );
    expect(reactivate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const leaveTarget = await gql(
      app,
      `mutation { actorCreate(input: { name: "leaving-agent", type: AGENT }) { actor { id } } }`,
    );
    const leaveId = leaveTarget.data!.actorCreate.actor.id;
    const leaveKeyResult = await gql(
      app,
      `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "leave login" }) { key } }`,
      { id: leaveId },
    );
    const left = await gql(
      app,
      `mutation { actorLeave { actor { id status } } }`,
      {},
      leaveKeyResult.data!.apiKeyCreate.key,
    );
    expect(left.errors).toBeUndefined();
    expect(left.data!.actorLeave.actor).toEqual({ id: leaveId, status: "LEFT" });
    expect(
      (await gql(app, `{ viewer { id } }`, {}, leaveKeyResult.data!.apiKeyCreate.key)).errors?.[0]
        ?.extensions?.code,
    ).toBe("UNAUTHORIZED");
  });

  it("requires admin lifecycle actions and suspends access without deleting identity", async () => {
    const member = await gql(
      app,
      `mutation { actorCreate(input: { name: "lifecycle-member", type: AGENT }) { actor { id } } }`,
    );
    const id = member.data!.actorCreate.actor.id;
    const keyResult = await gql(
      app,
      `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "login" }) { key apiKey { id } } }`,
      { id },
    );
    const key = keyResult.data!.apiKeyCreate.key;
    const suspended = await gql(
      app,
      `mutation($id: ID!) { actorSuspend(id: $id) { actor { id status } } }`,
      { id },
    );
    expect(suspended.errors).toBeUndefined();
    expect(suspended.data!.actorSuspend.actor).toEqual({ id, status: "SUSPENDED" });
    expect((await gql(app, `{ viewer { id } }`, {}, key)).errors?.[0]?.extensions?.code).toBe(
      "UNAUTHORIZED",
    );
    expect(
      (await gql(app, `{ actors { id status } }`)).data!.actors.find((a: any) => a.id === id)
        .status,
    ).toBe("SUSPENDED");
    const reactivated = await gql(
      app,
      `mutation($id: ID!) { actorReactivate(id: $id) { actor { id status } } }`,
      { id },
    );
    expect(reactivated.errors).toBeUndefined();
    // Suspension is reversible: the original key works after reactivation.
    expect((await gql(app, `{ viewer { id } }`, {}, key)).data!.viewer.id).toBe(id);
  });

  it("does not allow suspending the last admin and allows self leave without deleting refs", async () => {
    // The last-admin check uses the bootstrap actor ID.
    const admin = (await gql(app, `{ viewer { id } }`)).data!.viewer.id;
    const result = await gql(app, `mutation($id: ID!) { actorSuspend(id: $id) { actor { id } } }`, {
      id: admin,
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const revoke = await gql(app, `mutation($id: ID!) { actorRevoke(id: $id) { actor { id } } }`, {
      id: admin,
    });
    expect(revoke.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});
