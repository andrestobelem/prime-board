// PRB-403: identidad y alcance explícitos de la Repository Replica.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";
import { createTestApp } from "../test-helpers.ts";
import { createReplicaMetadata, parseReplicaMetadata } from "./replica-metadata.ts";

const app = createTestApp();
afterAll(() => app.stop());

function emptyDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

describe("PRB-403: metadata de Repository Replica", () => {
  it("escribe versión, workspaceId estable y scope workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-prb403-metadata-"));
    try {
      const workspace = app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
      exportBoard(app.db, root);
      expect(JSON.parse(readFileSync(join(root, ".prime-board/meta/export.json"), "utf8"))).toEqual(
        createReplicaMetadata(workspace.id),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("conserva el workspaceId al reconstruir y soporta scope team explícito", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-prb403-team-"));
    const rebuilt = emptyDb();
    try {
      const workspace = app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
      exportBoard(app.db, root, { teamKey: "PB" });
      const metadata = JSON.parse(
        readFileSync(join(root, ".prime-board/meta/export.json"), "utf8"),
      );
      expect(metadata).toMatchObject({
        version: 1,
        workspaceId: workspace.id,
        scope: "team:PB",
      });
      expect(() => rebuildFromRepo(rebuilt, root)).toThrow(/Refusing partial export/);
      expect(rebuildFromRepo(rebuilt, root, { allowPartial: true }).issues).toBe(0);
      expect((rebuilt.query("SELECT id FROM workspace").get() as { id: string }).id).toBe(
        workspace.id,
      );
    } finally {
      rebuilt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lee exports single-workspace históricos sin metadata versionada", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-prb403-legacy-"));
    const rebuilt = emptyDb();
    try {
      exportBoard(app.db, root);
      writeFileSync(
        join(root, ".prime-board/meta/export.json"),
        JSON.stringify({ scope: "workspace" }) + "\n",
      );
      expect(parseReplicaMetadata({ scope: "workspace" })).toEqual({
        version: null,
        workspaceId: null,
        scope: "workspace",
      });
      expect(rebuildFromRepo(rebuilt, root).issues).toBe(0);
    } finally {
      rebuilt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza un Workspace incompatible antes de borrar el destino", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-prb403-mismatch-"));
    const rebuilt = emptyDb();
    try {
      exportBoard(app.db, root);
      const localWorkspaceId = "local-workspace";
      const timestamp = "2026-01-01T00:00:00.000Z";
      rebuilt
        .query(
          "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, 'Local', 'local', ?2, ?2)",
        )
        .run(localWorkspaceId, timestamp);
      expect(() => rebuildFromRepo(rebuilt, root)).toThrow(/operational Workspace/);
      expect(rebuilt.query("SELECT id FROM workspace").get()).toEqual({ id: localWorkspaceId });
    } finally {
      rebuilt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza scopes incompatibles y no borra vecinos futuros", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-prb403-scope-"));
    const rebuilt = emptyDb();
    try {
      exportBoard(app.db, root);
      const metadataPath = join(root, ".prime-board/meta/export.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, scope: "organization" }) + "\n");
      expect(() => rebuildFromRepo(rebuilt, root)).toThrow(/Invalid export scope/);

      // Un destino futuro con varios Workspaces se rechaza en vez de borrarse
      // por completo, porque esta versión no tiene una topología operativa por alcance.
      writeFileSync(metadataPath, JSON.stringify(metadata) + "\n");
      const neighbor = "future-neighbor";
      const target = metadata.workspaceId as string;
      rebuilt
        .query(
          "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, 'Target', 'target', 'x', 'x'), (?2, 'Neighbor', 'neighbor', 'x', 'x')",
        )
        .run(target, neighbor);
      expect(() => rebuildFromRepo(rebuilt, root)).toThrow(/multi-Workspace/);
      expect(rebuilt.query("SELECT id FROM workspace WHERE id = ?1").get(neighbor)).toEqual({
        id: neighbor,
      });
    } finally {
      rebuilt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
