import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../db/database.ts";
import { seedWorkspace } from "../db/seed.ts";
import type { Persistence } from "../db/persistence.ts";
import { exportPostgresBoard } from "./postgres-export.ts";

function fixturePersistence(db: ReturnType<typeof openDatabase>): Persistence {
  return {
    many: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      if (sql.includes("information_schema.columns")) {
        const table = String(params[0]);
        return db
          .query(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
          .all()
          .map((column) => ({ column_name: (column as { name: string }).name })) as Row[];
      }
      const match = sql.match(/FROM "([^"]+)"/);
      if (!match) throw new Error(`Unexpected fixture query: ${sql}`);
      return db.query(sql).all() as Row[];
    },
    one: async () => null,
    execute: async () => ({ rows: [], rowCount: 0 }),
    transaction: async () => {
      throw new Error("Unexpected transaction in export fixture");
    },
    close: async () => {},
  } as unknown as Persistence;
}

describe("PostgreSQL board export", () => {
  test("projects teams before workflow states without violating foreign keys", async () => {
    const source = openDatabase(":memory:");
    const root = mkdtempSync(join(tmpdir(), "prime-board-postgres-export-"));
    try {
      seedWorkspace(source, {
        name: "Export workspace",
        urlKey: "export-workspace",
        teamName: "Export team",
        teamKey: "EXP",
      });
      const result = await exportPostgresBoard(fixturePersistence(source), root);
      expect(result.files).toBeGreaterThan(0);
      expect(existsSync(join(root, ".prime-board", "meta", "teams.json"))).toBe(true);
      // PostgreSQL projection intentionally omits retired Documents and does
      // not require documents.json to be present.
      expect(existsSync(join(root, ".prime-board", "meta", "documents.json"))).toBe(false);
      const teams = JSON.parse(
        readFileSync(join(root, ".prime-board", "meta", "teams.json"), "utf8"),
      ) as Array<{ key: string; defaultState: string | null }>;
      expect(teams).toEqual([
        expect.objectContaining({
          key: "EXP",
          defaultState: "Backlog",
        }),
      ]);
    } finally {
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archives legacy PostgreSQL Documents before projecting the board", async () => {
    const source = openDatabase(":memory:");
    const root = mkdtempSync(join(tmpdir(), "prime-board-postgres-documents-export-"));
    try {
      seedWorkspace(source, {
        name: "Export workspace",
        urlKey: "export-workspace",
        teamName: "Export team",
        teamKey: "EXP",
      });
      source.exec(`
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL
        );
        INSERT INTO documents (id, title, content)
        VALUES ('legacy-doc', 'Legacy runbook', 'Do not lose this content');
      `);
      const archivePath = join(root, "backup", "documents.archive.json");
      const replicaSnapshot = join(root, ".prime-board", "meta", "documents.json");
      mkdirSync(join(root, ".prime-board", "meta"), { recursive: true });
      writeFileSync(replicaSnapshot, '[{"title":"Replica runbook","content":"old snapshot"}]\n');
      const result = await exportPostgresBoard(fixturePersistence(source), root, {
        documentsArchivePath: archivePath,
      });
      expect(result.files).toBeGreaterThan(0);
      const archive = JSON.parse(readFileSync(archivePath, "utf8")) as {
        count: number;
        sources: {
          postgres: { count: number; documents: Array<{ title: string }> };
          replica: { count: number; documents: Array<{ title: string }> };
        };
      };
      expect(archive.count).toBe(2);
      expect(archive.sources.postgres).toMatchObject({
        count: 1,
        documents: [{ title: "Legacy runbook" }],
      });
      expect(archive.sources.replica).toMatchObject({
        count: 1,
        documents: [{ title: "Replica runbook" }],
      });
      expect(existsSync(join(root, ".prime-board", "meta", "documents.json"))).toBe(false);
    } finally {
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rechaza exportar PostgreSQL con Documents históricos sin archivo", async () => {
    const source = openDatabase(":memory:");
    const root = mkdtempSync(join(tmpdir(), "prime-board-postgres-documents-export-"));
    try {
      seedWorkspace(source, {
        name: "Export workspace",
        urlKey: "export-workspace",
        teamName: "Export team",
        teamKey: "EXP",
      });
      source.exec(`
        CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL);
        INSERT INTO documents (id, title, content) VALUES ('legacy-doc', 'Legacy', 'private');
      `);
      await expect(exportPostgresBoard(fixturePersistence(source), root)).rejects.toThrow(
        /Cannot export PostgreSQL Documents with data/,
      );
    } finally {
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
