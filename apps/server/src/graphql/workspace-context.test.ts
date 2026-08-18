import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp } from "../test-helpers.ts";
import { assertWorkspaceId, resolveWorkspaceContext } from "../domain/workspace-context.ts";

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
});
