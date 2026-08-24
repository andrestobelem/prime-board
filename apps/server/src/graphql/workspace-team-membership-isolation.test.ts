// PRB-476: el Workspace activo limita las mutaciones de membresías.
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

    // El mismo actor es owner del Team en A. Su rol member en B no debe
    // permitir que el camino de owner omita el Workspace efectivo.
    app.db
      .query("UPDATE team_memberships SET role = 'owner' WHERE team_id = ?1 AND actor_id = ?2")
      .run(teamId, adminId);
    app.db
      .query(
        "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ?1 AND actor_id = ?2",
      )
      .run(workspaceB, adminId);

    const ownerCrossWorkspaceDelete = await gql(
      app,
      `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
      { id: membershipId },
      app.apiKey,
      "membership-isolation-b",
    );
    expect(ownerCrossWorkspaceDelete.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(
      (
        app.db
          .query("SELECT count(*) AS count FROM team_memberships WHERE id = ?1")
          .get(membershipId) as { count: number }
      ).count,
    ).toBe(1);

    const workspaceA = (
      app.db.query("SELECT id FROM workspace WHERE url_key = 'prime-board'").get() as { id: string }
    ).id;
    const ownerSameWorkspaceDelete = await gql(
      app,
      `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
      { id: membershipId },
      app.apiKey,
      workspaceA,
    );
    expect(ownerSameWorkspaceDelete.errors).toBeUndefined();
    expect(ownerSameWorkspaceDelete.data!.teamMembershipDelete.success).toBe(true);
    expect(
      (
        app.db
          .query("SELECT count(*) AS count FROM team_memberships WHERE id = ?1")
          .get(membershipId) as { count: number }
      ).count,
    ).toBe(0);
  });

  it("permite filas legacy NULL mientras existe un único Workspace", async () => {
    const legacyApp = createTestApp();
    try {
      const setup = await gql(legacyApp, `{ team(key: "PB") { id } viewer { id } }`);
      expect(setup.errors).toBeUndefined();
      const teamId = setup.data!.team.id as string;
      const actor = await gql(
        legacyApp,
        `mutation { actorCreate(input: { name: "Legacy member", type: AGENT }) { actor { id } } }`,
      );
      expect(actor.errors).toBeUndefined();
      const actorId = actor.data!.actorCreate.actor.id as string;
      const created = await gql(
        legacyApp,
        `mutation($input: TeamMembershipCreateInput!) {
          teamMembershipCreate(input: $input) { membership { id } }
        }`,
        { input: { teamId, actorId, role: "MEMBER" } },
      );
      expect(created.errors).toBeUndefined();
      const membershipId = created.data!.teamMembershipCreate.membership.id as string;
      legacyApp.db
        .query("UPDATE team_memberships SET workspace_id = NULL WHERE id = ?1")
        .run(membershipId);

      const workspaceId = (legacyApp.db.query("SELECT id FROM workspace").get() as { id: string })
        .id;
      const deleted = await gql(
        legacyApp,
        `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
        { id: membershipId },
        legacyApp.apiKey,
        workspaceId,
      );
      expect(deleted.errors).toBeUndefined();
      expect(deleted.data!.teamMembershipDelete.success).toBe(true);
    } finally {
      legacyApp.stop();
    }
  });

  it("rechaza filas legacy NULL cuando la topología tiene varios Workspaces", async () => {
    const legacyApp = createTestApp();
    try {
      const setup = await gql(legacyApp, `{ team(key: "PB") { id } viewer { id } }`);
      expect(setup.errors).toBeUndefined();
      const teamId = setup.data!.team.id as string;
      const actor = await gql(
        legacyApp,
        `mutation { actorCreate(input: { name: "Legacy multi member", type: AGENT }) { actor { id } } }`,
      );
      expect(actor.errors).toBeUndefined();
      const actorId = actor.data!.actorCreate.actor.id as string;
      const created = await gql(
        legacyApp,
        `mutation($input: TeamMembershipCreateInput!) {
          teamMembershipCreate(input: $input) { membership { id } }
        }`,
        { input: { teamId, actorId, role: "MEMBER" } },
      );
      expect(created.errors).toBeUndefined();
      const membershipId = created.data!.teamMembershipCreate.membership.id as string;
      legacyApp.db
        .query("UPDATE team_memberships SET workspace_id = NULL WHERE id = ?1")
        .run(membershipId);

      const workspaceB = await workspaceIdFor(legacyApp, "membership-legacy-multi-b");
      const viewerId = setup.data!.viewer.id as string;
      legacyApp.db
        .query(
          "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ?1 AND actor_id = ?2",
        )
        .run(workspaceB, viewerId);
      const deleted = await gql(
        legacyApp,
        `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
        { id: membershipId },
        legacyApp.apiKey,
        workspaceB,
      );
      expect(deleted.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
      expect(
        (
          legacyApp.db
            .query("SELECT count(*) AS count FROM team_memberships WHERE id = ?1")
            .get(membershipId) as { count: number }
        ).count,
      ).toBe(1);
    } finally {
      legacyApp.stop();
    }
  });
});
