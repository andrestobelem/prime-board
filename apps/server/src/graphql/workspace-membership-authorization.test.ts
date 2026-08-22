// Regresión propuesta para el aislamiento de permisos por Workspace.
import { describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";
import { resolveAuth } from "../auth/viewer.ts";

async function createWorkspace(app: TestApp, urlKey: string): Promise<string> {
  const result = await gql(
    app,
    `mutation($urlKey: String!) {
      workspaceCreate(input: { name: "Membership test", urlKey: $urlKey }) {
        workspace { id urlKey }
      }
    }`,
    { urlKey },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.workspaceCreate.workspace.id as string;
}

describe("autorización por Workspace Membership", () => {
  it("no usa el workspace_role global para elevar un actor en otro Workspace", async () => {
    const app = createTestApp();
    try {
      const workspaceId = await createWorkspace(app, "membership-role-other");
      const adminId = (
        app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }
      ).id;

      // El Actor sigue siendo admin por compatibilidad global, pero es member en
      // el Workspace efectivo. El grant de la key sí autoriza este Workspace.
      app.db
        .query(
          "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ?1 AND actor_id = ?2",
        )
        .run(workspaceId, adminId);

      const viewer = await gql(
        app,
        "{ viewer { workspaceRole } workspace { role } }",
        {},
        app.apiKey,
        "membership-role-other",
      );
      expect(viewer.errors).toBeUndefined();
      expect(viewer.data!.workspace.role).toBe("MEMBER");
      // Este assert queda rojo mientras Viewer exponga el rol global del Actor.
      expect(viewer.data!.viewer.workspaceRole).toBe("MEMBER");
    } finally {
      app.stop();
    }
  });

  it("rechaza mutations de admin aunque el Actor conserve rol admin global", async () => {
    const app = createTestApp();
    try {
      const workspaceId = await createWorkspace(app, "membership-role-guard");
      const adminId = (
        app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }
      ).id;
      app.db
        .query(
          "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ?1 AND actor_id = ?2",
        )
        .run(workspaceId, adminId);

      const before = (
        app.db.query("SELECT count(*) AS count FROM actors").get() as { count: number }
      ).count;
      const created = await gql(
        app,
        `mutation { actorCreate(input: { name: "must-not-be-created", type: AGENT }) { success } }`,
        {},
        app.apiKey,
        "membership-role-guard",
      );
      expect(created.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
      const after = (
        app.db.query("SELECT count(*) AS count FROM actors").get() as { count: number }
      ).count;
      expect(after).toBe(before);
    } finally {
      app.stop();
    }
  });

  it("usa el status de la Membership aunque el Actor global esté suspendido", async () => {
    const app = createTestApp();
    try {
      const workspaceId = await createWorkspace(app, "membership-status-other");
      const adminId = (
        app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }
      ).id;
      const key = `Bearer ${app.apiKey}`;

      // Con dos Workspaces el trigger legacy no copia este cambio a la Membership.
      // La Membership efectiva permanece admin/active aunque el Actor global no.
      app.db.query("UPDATE actors SET status = 'suspended' WHERE id = ?1").run(adminId);
      const membership = app.db
        .query(
          "SELECT role, status FROM workspace_memberships WHERE workspace_id = ?1 AND actor_id = ?2",
        )
        .get(workspaceId, adminId) as { role: string; status: string };
      expect(membership).toEqual({ role: "admin", status: "active" });

      const auth = resolveAuth(app.db, key, "membership-status-other");
      expect(auth?.workspaceId).toBe(workspaceId);

      const updated = await gql(
        app,
        `mutation { workspaceUpdate(input: { name: "Membership status works" }) { success } }`,
        {},
        app.apiKey,
        "membership-status-other",
      );
      expect(updated.errors).toBeUndefined();
      expect(updated.data!.workspaceUpdate.success).toBe(true);
    } finally {
      app.stop();
    }
  });

  it("no recarga el rol global al crear una iniciativa en otro Workspace", async () => {
    const app = createTestApp();
    try {
      const workspaceId = await createWorkspace(app, "membership-initiative-guard");
      const adminId = (
        app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }
      ).id;
      const teamId = (
        app.db.query("SELECT id FROM teams WHERE workspace_id = ?1").get(workspaceId) as {
          id: string;
        }
      ).id;
      app.db
        .query(
          "UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ?1 AND actor_id = ?2",
        )
        .run(workspaceId, adminId);
      app.db
        .query("DELETE FROM team_memberships WHERE team_id = ?1 AND actor_id = ?2")
        .run(teamId, adminId);
      app.db
        .query(
          "UPDATE teams SET visibility = 'private', access_policy = 'team_members' WHERE id = ?1",
        )
        .run(teamId);

      const created = await gql(
        app,
        `mutation($teamId: ID!) {
          initiativeCreate(input: { name: "must-not-be-created", teamIds: [$teamId] }) {
            success
          }
        }`,
        { teamId },
        app.apiKey,
        "membership-initiative-guard",
      );
      expect(created.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
      expect(
        (app.db.query("SELECT count(*) AS count FROM initiatives").get() as { count: number })
          .count,
      ).toBe(0);
    } finally {
      app.stop();
    }
  });
});
