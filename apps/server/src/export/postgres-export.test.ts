import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
