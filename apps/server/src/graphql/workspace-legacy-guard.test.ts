import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/database.ts";
import { resolveWorkspaceContext } from "../domain/workspace-context.ts";
import { scopeWorkspaceRow, scopeWorkspaceRows } from "../domain/workspace-guards.ts";

function database(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
  ).run("workspace-legacy-first", "Legacy first", "legacy-first", "2025-01-01T00:00:00.000Z");
  return db;
}

describe("legacy Workspace guard", () => {
  it("keeps explicit NULL rows in the single-Workspace compatibility mode", () => {
    const db = database();
    try {
      const context = { db, workspace: resolveWorkspaceContext(db) };
      const legacy = { id: "legacy", workspace_id: null };
      expect(scopeWorkspaceRow(context, legacy)).toBe(legacy);
      expect(scopeWorkspaceRows(context, [legacy])).toEqual([legacy]);
    } finally {
      db.close();
    }
  });

  it("fails closed for explicit NULL rows after a second Workspace exists", () => {
    const db = database();
    try {
      const first = { db, workspace: resolveWorkspaceContext(db) };
      const secondId = "workspace-legacy-guard";
      db.query(
        "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      ).run(secondId, "Legacy guard", "legacy-guard", "2025-01-01T00:00:00.000Z");
      const second = { db, workspace: resolveWorkspaceContext(db, secondId) };
      const legacy = { id: "legacy", workspace_id: null };

      expect(scopeWorkspaceRows(first, [legacy])).toEqual([]);
      expect(scopeWorkspaceRows(second, [legacy])).toEqual([]);
      expect(() => scopeWorkspaceRow(first, legacy)).toThrow(
        "Resource not found in the active Workspace",
      );
    } finally {
      db.close();
    }
  });
});
