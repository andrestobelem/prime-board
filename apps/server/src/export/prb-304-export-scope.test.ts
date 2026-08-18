import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql } from "../test-helpers.ts";
import { migrate } from "../db/database.ts";
import { newId, now } from "../db/util.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";

describe("PRB-304: alcance de export parcial", () => {
  const app = createTestApp();
  afterAll(() => app.stop());

  it("recorta recursos de otros teams y reconstruye sin referencias externas", async () => {
    const other = await gql(
      app,
      `mutation { teamCreate(input: { name: "Other", key: "OT" }) { team { id } } }`,
    );
    const pb = (await gql(app, `{ team(key: "PB") { id } }`)).data!.team.id as string;
    const ot = other.data!.teamCreate.team.id as string;
    const createProject = async (name: string, teamId: string) =>
      (
        await gql(
          app,
          `mutation($name: String!, $teams: [ID!]) { projectCreate(input: { name: $name, teamIds: $teams }) { project { id } } }`,
          { name, teams: [teamId] },
        )
      ).data!.projectCreate.project.id as string;
    const pbProject = await createProject("PB project", pb);
    const otProject = await createProject("OT project", ot);
    const actor = (
      app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }
    ).id;
    const timestamp = now();
    const initiative = newId();
    app.db
      .query(
        `INSERT INTO initiatives (id, name, description, state, target_date, owner_id, created_at, updated_at)
         VALUES (?1, 'OT initiative', NULL, 'active', NULL, ?2, ?3, ?3)`,
      )
      .run(initiative, actor, timestamp);
    app.db
      .query("INSERT INTO initiative_projects (initiative_id, project_id) VALUES (?1, ?2)")
      .run(initiative, otProject);
    app.db
      .query("INSERT INTO initiative_teams (initiative_id, team_id) VALUES (?1, ?2)")
      .run(initiative, ot);
    app.db
      .query(
        `INSERT INTO project_updates (id, project_id, author_id, health, body, risks, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'on_track', 'OT update', NULL, ?4, ?4)`,
      )
      .run(newId(), otProject, actor, timestamp);
    const otIssue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "OT", title: "OT issue" }) { issue { id } } }`,
    );
    const otIssueId = otIssue.data!.issueCreate.issue.id as string;
    app.db
      .query(
        `INSERT INTO reviews (id, issue_id, requester_id, reviewer_id, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3, 'requested', ?4, ?4)`,
      )
      .run(newId(), otIssueId, actor, timestamp);
    const activity = app.db
      .query("SELECT id FROM activity WHERE issue_id = ?1 ORDER BY created_at, id LIMIT 1")
      .get(otIssueId) as { id: string };
    app.db
      .query(
        "INSERT INTO inbox_receipts (activity_id, actor_id, read_at, archived_at) VALUES (?1, ?2, NULL, NULL)",
      )
      .run(activity.id, actor);
    // Ensure the selected project is not accidentally dropped while filtering.
    expect(pbProject).toBeString();

    const dir = mkdtempSync(join(tmpdir(), "pb-prb304-"));
    try {
      exportBoard(app.db, dir, { teamKey: "PB" });
      const base = join(dir, ".prime-board", "meta");
      expect(JSON.parse(readFileSync(join(base, "teams.json"), "utf8"))).toHaveLength(1);
      for (const file of [
        "projects",
        "cycles",
        "project-updates",
        "initiatives",
        "reviews",
        "inbox-receipts",
        "favorites",
      ]) {
        expect(readFileSync(join(base, `${file}.json`), "utf8")).not.toContain("OT");
      }
      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      expect(rebuildFromRepo(fresh, dir, { allowPartial: true }).issues).toBe(0);
      expect(fresh.query("SELECT key FROM teams").all()).toEqual([{ key: "PB" }]);
      expect(fresh.query("SELECT name FROM projects").all()).toEqual([{ name: "PB project" }]);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
