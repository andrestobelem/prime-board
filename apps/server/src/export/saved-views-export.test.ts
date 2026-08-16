// PRB-209: export/import de saved views sin pérdidas.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("saved views export/import", () => {
  it("redondea vistas por export → rebuild", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    await gql(
      app,
      `mutation($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) { savedView { id } }
      }`,
      {
        input: {
          name: "Export me",
          scope: "TEAM",
          teamId: team.data!.team.id,
          filter: { unblocked: true },
          orderBy: "UPDATED_DESC",
          groupBy: "priority",
          columns: ["identifier", "title"],
        },
      },
    );

    const dir = mkdtempSync(join(tmpdir(), "pb-views-"));
    try {
      exportBoard(app.db, dir);
      const raw = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "saved-views.json"), "utf8"),
      );
      expect(raw).toEqual([
        {
          name: "Export me",
          scope: "team",
          team: "PB",
          owner: "admin",
          filter: { unblocked: true },
          orderBy: "UPDATED_DESC",
          groupBy: "priority",
          columns: ["identifier", "title"],
          archived: false,
        },
      ]);

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      // Seed mínimo de workspace vacío no hace falta: rebuild recrea todo.
      // Pero rebuild necesita actors.json etc from export.
      rebuildFromRepo(fresh, dir);

      const restored = fresh
        .query(`SELECT name, scope, order_by, group_by, columns_json, filter_json FROM saved_views`)
        .all() as Array<Record<string, string>>;
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        name: "Export me",
        scope: "team",
        order_by: "UPDATED_DESC",
        group_by: "priority",
      });
      const row = restored[0]!;
      expect(JSON.parse(String(row.columns_json))).toEqual(["identifier", "title"]);
      expect(JSON.parse(String(row.filter_json))).toEqual({ unblocked: true });
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
