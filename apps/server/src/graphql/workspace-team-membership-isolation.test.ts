// PRB-476: una admin del Workspace activo no puede mutar membresías de otro Workspace.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

async function workspaceIdFor(app: TestApp, urlKey: string): Promise<string> {
  const result = await gql(
    app,
    `mutation($urlKey: String!) {
      workspaceCreate(input: { name: "Membership isolation", urlKey: $urlKey }) {
        workspace { id urlKey }
      }
    }`,
    { urlKey },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.workspaceCreate.workspace.id as string;
}

describe("workspace scope for team memberships", () => {
  const app = createTestApp();
  afterAll(() => app.stop());

  it("no permite a un admin del Workspace B borrar una membresía de A", async () => {
    const setup = await gql(app, `{ team(key: "PB") { id } viewer { id } }`);
    expect(setup.errors).toBeUndefined();
    const teamId = setup.data!.team.id as string;
    const adminId = setup.data!.viewer.id as string;

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "Workspace A member", type: AGENT }) { actor { id } } }`,
    );
    expect(actor.errors).toBeUndefined();
    const actorId = actor.data!.actorCreate.actor.id as string;

    const created = await gql(
      app,
      `mutation($input: TeamMembershipCreateInput!) {
        teamMembershipCreate(input: $input) { membership { id } }
      }`,
      { input: { teamId, actorId, role: "MEMBER" } },
    );
    expect(created.errors).toBeUndefined();
    const membershipId = created.data!.teamMembershipCreate.membership.id as string;

    const workspaceB = await workspaceIdFor(app, "membership-isolation-b");
    app.db
      .query(
        "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = (SELECT workspace_id FROM teams WHERE id = ?1) AND actor_id = ?2",
      )
      .run(teamId, adminId);
    app.db
      .query("UPDATE team_memberships SET role = 'member' WHERE team_id = ?1 AND actor_id = ?2")
      .run(teamId, adminId);

    const deleted = await gql(
      app,
      `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
      { id: membershipId },
      app.apiKey,
      "membership-isolation-b",
    );
    expect(deleted.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(
      (
        app.db
          .query("SELECT count(*) AS count FROM team_memberships WHERE id = ?1")
          .get(membershipId) as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        app.db
          .query("SELECT role FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2")
          .get(workspaceB, adminId) as { role: string }
      ).role,
    ).toBe("admin");
  });
});
