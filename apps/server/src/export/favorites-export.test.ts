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

  it("conserva favoritos de vistas con alcance Project e Initiative", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id as string;
    const project = await gql(
      app,
      `mutation($teamId: ID!) {
        projectCreate(input: { name: "Project favorite target", teamIds: [$teamId] }) {
          project { id }
        }
      }`,
      { teamId },
    );
    const projectId = project.data!.projectCreate.project.id as string;
    const initiative = await gql(
      app,
      `mutation($teamId: ID!, $projectId: ID!) {
        initiativeCreate(input: {
          name: "Initiative favorite target"
          teamIds: [$teamId]
          projectIds: [$projectId]
        }) { initiative { id } }
      }`,
      { teamId, projectId },
    );
    const initiativeId = initiative.data!.initiativeCreate.initiative.id as string;
    const views = await gql(
      app,
      `mutation($projectId: ID!, $initiativeId: ID!) {
        projectView: savedViewCreate(input: {
          name: "Project favorite view"
          scope: PROJECT
          projectId: $projectId
          orderBy: UPDATED_ASC
          groupBy: "priority"
          columns: ["identifier", "title"]
          layout: BOARD
        }) { savedView { id } }
        initiativeView: savedViewCreate(input: {
          name: "Initiative favorite view"
          scope: INITIATIVE
          initiativeId: $initiativeId
          orderBy: CREATED_ASC
          groupBy: "assignee"
          columns: ["identifier", "assignee"]
          layout: BOARD
        }) { savedView { id } }
      }`,
      { projectId, initiativeId },
    );
    expect(views.errors).toBeUndefined();
    const projectViewId = views.data!.projectView.savedView.id as string;
    const initiativeViewId = views.data!.initiativeView.savedView.id as string;
    const favoriteAndSubscriptions = await gql(
      app,
      `mutation($projectViewId: ID!, $initiativeViewId: ID!) {
        projectFavorite: favoriteCreate(input: { savedViewId: $projectViewId }) {
          favorite { id }
        }
        initiativeFavorite: favoriteCreate(input: { savedViewId: $initiativeViewId }) {
          favorite { id }
        }
        projectSubscription: viewSubscriptionUpdate(
          viewId: $projectViewId
          input: { issueChanges: false, slack: true }
        ) { subscription { id } }
        initiativeSubscription: viewSubscriptionUpdate(
          viewId: $initiativeViewId
          input: { issueChanges: true, slack: true }
        ) { subscription { id } }
      }`,
      { projectViewId, initiativeViewId },
    );
    expect(favoriteAndSubscriptions.errors).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "pb-scoped-view-favorites-"));
    try {
      exportBoard(app.db, dir);
      const exportedViews = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "saved-views.json"), "utf8"),
      ) as Array<Record<string, unknown>>;
      expect(exportedViews).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Project favorite view",
            scope: "project",
            project: "Project favorite target",
          }),
          expect.objectContaining({
            name: "Initiative favorite view",
            scope: "initiative",
            initiative: "Initiative favorite target",
          }),
        ]),
      );

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);
      const restored = fresh
        .query(
          `SELECT sv.name, sv.scope, p.name AS project_name, i.name AS initiative_name,
                  vp.layout, vp.order_by, vp.group_by, vp.columns_json,
                  vs.issue_changes, vs.slack, f.position
           FROM saved_views sv
           LEFT JOIN projects p ON p.id = sv.project_id
           LEFT JOIN initiatives i ON i.id = sv.initiative_id
           LEFT JOIN view_preferences vp ON vp.view_id = sv.id AND vp.scope = 'actor'
           LEFT JOIN view_subscriptions vs ON vs.view_id = sv.id
           LEFT JOIN favorites f ON f.saved_view_id = sv.id
           WHERE sv.name IN ('Project favorite view', 'Initiative favorite view')
           ORDER BY sv.name`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(restored).toHaveLength(2);
      expect(restored).toEqual([
        {
          name: "Initiative favorite view",
          scope: "initiative",
          project_name: null,
          initiative_name: "Initiative favorite target",
          layout: "board",
          order_by: "CREATED_ASC",
          group_by: "assignee",
          columns_json: '["identifier","assignee"]',
          issue_changes: 1,
          slack: 1,
          position: 3,
        },
        {
          name: "Project favorite view",
          scope: "project",
          project_name: "Project favorite target",
          initiative_name: null,
          layout: "board",
          order_by: "UPDATED_ASC",
          group_by: "priority",
          columns_json: '["identifier","title"]',
          issue_changes: 0,
          slack: 1,
          position: 2,
        },
      ]);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
