import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";
import { assertWorkspaceId, resolveWorkspaceContext } from "../domain/workspace-context.ts";
import { resolveAuth } from "../auth/viewer.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("WorkspaceContext", () => {
  it("resuelve el Workspace singleton sin aceptar un selector del caller", () => {
    const context = resolveWorkspaceContext(app.db);
    const workspace = app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
    expect(context).toEqual({ workspaceId: workspace.id });
  });

  it("rechaza una referencia de otro Workspace", () => {
    const context = resolveWorkspaceContext(app.db);
    expect(() => assertWorkspaceId(context, "workspace-from-another-tenant")).toThrow(
      "Resource not found in the active Workspace",
    );
    expect(() => assertWorkspaceId(context, context.workspaceId)).not.toThrow();
  });

  it("resuelve el grant y la Membership del Workspace seleccionado", async () => {
    const current = app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
    const actor = app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as {
      id: string;
    };
    const key = app.db.query("SELECT id FROM api_keys LIMIT 1").get() as { id: string };
    const other = "workspace-context-other";
    app.db
      .query(
        `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
         VALUES (?1, 'Other', 'other-context', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
      )
      .run(other);
    app.db
      .query(
        `INSERT INTO workspace_memberships
         (id, workspace_id, actor_id, role, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'admin', 'active', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
      )
      .run(`${other}:${actor.id}`, other, actor.id);
    app.db
      .query(
        `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
         VALUES (?1, ?2, 0, '2099-01-01T00:00:00.000Z')`,
      )
      .run(key.id, other);
    app.db.query("UPDATE api_key_workspaces SET is_default = 0 WHERE api_key_id = ?1").run(key.id);

    const bearer = `Bearer ${app.apiKey}`;
    expect(resolveAuth(app.db, bearer, current.id)?.workspaceId).toBe(current.id);
    expect(resolveAuth(app.db, bearer, "other-context")?.workspaceId).toBe(other);
    expect(() => resolveAuth(app.db, bearer)).toThrow("A Workspace selector is required");
    expect(() => resolveAuth(app.db, bearer, "not-granted")).toThrow(
      "Workspace access is not granted",
    );
    const selected = await gql(app, "{ workspace { id urlKey } }", {}, app.apiKey, "other-context");
    expect(selected.errors).toBeUndefined();
    expect(selected.data?.workspace).toEqual({ id: other, urlKey: "other-context" });
    const ambiguous = await gql(app, "{ workspace { id } }");
    expect(ambiguous.errors?.[0]?.extensions?.code).toBe("WORKSPACE_REQUIRED");
  });
});
