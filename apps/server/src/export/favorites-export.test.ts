// PRB-268: favoritos en el snapshot del repo sin UUIDs ni credenciales.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql } from "../test-helpers.ts";
import { migrate } from "../db/database.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("favorites export/import", () => {
  it("conserva proyectos, vistas y orden por actor usando claves naturales", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const project = await gql(
      app,
      `mutation($team: ID!) { projectCreate(input: { name: "Export favorite project", teamIds: [$team] }) { project { id } } }`,
      { team: team.data!.team.id },
    );
    const projectId = project.data!.projectCreate.project.id;
    const view = await gql(
      app,
      `mutation { savedViewCreate(input: { name: "Export favorite view", scope: WORKSPACE }) { savedView { id } } }`,
    );
    const viewId = view.data!.savedViewCreate.savedView.id;
    await gql(
      app,
      `mutation($project: ID!, $view: ID!) {
        projectFavorite: favoriteCreate(input: { projectId: $project }) { favorite { id } }
        viewFavorite: favoriteCreate(input: { savedViewId: $view }) { favorite { id } }
      }`,
      { project: projectId, view: viewId },
    );
    const dir = mkdtempSync(join(tmpdir(), "pb-favorites-"));
    try {
      exportBoard(app.db, dir);
      const raw = readFileSync(join(dir, ".prime-board", "meta", "favorites.json"), "utf8");
      expect(raw).not.toContain(projectId);
      expect(raw).not.toContain(viewId);
      expect(raw).not.toContain("secret");
      expect(JSON.parse(raw)).toEqual([
        {
          actor: "admin",
          project: "Export favorite project",
          savedView: null,
          position: 0,
        },
        {
          actor: "admin",
          project: null,
          savedView: {
            name: "Export favorite view",
            scope: "workspace",
            team: null,
            owner: "admin",
          },
          position: 1,
        },
      ]);

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);
      const restored = fresh
        .query(
          `SELECT f.position, p.name AS project_name, sv.name AS view_name
           FROM favorites f
           LEFT JOIN projects p ON p.id = f.project_id
           LEFT JOIN saved_views sv ON sv.id = f.saved_view_id
           ORDER BY f.position`,
        )
        .all() as Array<{
        position: number;
        project_name: string | null;
        view_name: string | null;
      }>;
      expect(restored).toEqual([
        { position: 0, project_name: "Export favorite project", view_name: null },
        { position: 1, project_name: null, view_name: "Export favorite view" },
      ]);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
