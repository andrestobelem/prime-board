import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql } from "../test-helpers.ts";
import { migrate } from "../db/database.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";

describe("PRB-305: colisiones de proyectos", () => {
  const app = createTestApp();
  afterAll(() => app.stop());

  it("rechaza snapshots homónimos antes de borrar el índice destino", async () => {
    const team = (await gql(app, `{ team(key: "PB") { id } }`)).data!.team.id as string;
    await gql(
      app,
      `mutation($teams: [ID!]) { projectCreate(input: { name: "Collision", teamIds: $teams }) { project { id } } }`,
      { teams: [team] },
    );
    const dir = mkdtempSync(join(tmpdir(), "pb-prb305-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, dir);
      const path = join(dir, ".prime-board", "meta", "projects.json");
      const projects = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify([...projects, projects[0]], null, 2));
      migrate(fresh);
      const sentinel = fresh.query("SELECT count(*) AS count FROM teams").get() as {
        count: number;
      };
      expect(() => rebuildFromRepo(fresh, dir)).toThrow(/Ambiguous project reference/);
      expect(fresh.query("SELECT count(*) AS count FROM teams").get()).toEqual(sentinel);
    } finally {
      fresh.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
