// PRB-209: export/import de saved views sin pérdidas.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const team = await gql(app, `{ team(key: "PB") { id states { id name } } }`);
    const teamId = team.data!.team.id as string;
    const state = team.data!.team.states[0];
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "saved-filter-agent", type: AGENT }) { actor { id name } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const label = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "saved-filter-label", teamId: $teamId }) { label { id } } }`,
      { teamId },
    );
    const labelId = label.data!.labelCreate.label.id as string;
    const project = await gql(
      app,
      `mutation($teamIds: [ID!]) {
        projectCreate(input: { name: "Saved filter project", teamIds: $teamIds }) { project { id } }
      }`,
      { teamIds: [teamId] },
    );
    const projectId = project.data!.projectCreate.project.id as string;
    const milestone = await gql(
      app,
      `mutation($projectId: ID!) {
        milestoneCreate(input: { projectId: $projectId, name: "Saved filter milestone" }) { milestone { id } }
      }`,
      { projectId },
    );
    const milestoneId = milestone.data!.milestoneCreate.milestone.id as string;
    const cycle = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: { teamId: $teamId, name: "Saved filter cycle", startsAt: "2027-02-01", endsAt: "2027-02-14" }) {
          cycle { id number }
        }
      }`,
      { teamId },
    );
    const cycleId = cycle.data!.cycleCreate.cycle.id as string;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Saved filter issue" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id as string;
    await gql(
      app,
      `mutation($issueId: ID!, $actorId: ID!, $labelId: ID!) {
        issueUpdate(id: $issueId, input: { assigneeId: $actorId, addLabelIds: [$labelId] }) { success }
      }`,
      { issueId, actorId, labelId },
    );
    const filter = {
      team: { eq: teamId },
      state: { eq: state.id },
      assignee: { eq: actorId },
      labels: { includes: labelId, includesAll: [labelId] },
      project: { eq: projectId },
      milestone: { eq: milestoneId },
      cycle: { eq: cycleId },
      parent: { eq: issueId },
      and: [{ creator: { in: [actorId] } }],
      or: [{ team: { eq: teamId } }],
    };
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
          filter,
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
          filter: {
            team: { eq: "PB" },
            state: { eq: `PB/${state.name}` },
            assignee: { eq: "saved-filter-agent" },
            labels: {
              includes: "PB/saved-filter-label",
              includesAll: ["PB/saved-filter-label"],
            },
            project: { eq: "Saved filter project" },
            milestone: { eq: "Saved filter project/Saved filter milestone" },
            cycle: { eq: `PB/${cycle.data!.cycleCreate.cycle.number}` },
            parent: { eq: "PB-1" },
            and: [{ creator: { in: ["saved-filter-agent"] } }],
            or: [{ team: { eq: "PB" } }],
          },
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
      const restoredTeamId = (
        fresh.query("SELECT id FROM teams WHERE key = 'PB'").get() as {
          id: string;
        }
      ).id;
      const restoredStateId = (
        fresh.query("SELECT id FROM workflow_states WHERE name = ?1").get(state.name) as {
          id: string;
        }
      ).id;
      const restoredActorId = (
        fresh.query("SELECT id FROM actors WHERE name = 'saved-filter-agent'").get() as {
          id: string;
        }
      ).id;
      const restoredLabelId = (
        fresh
          .query(
            "SELECT labels.id FROM labels JOIN teams ON teams.id = labels.team_id " +
              "WHERE teams.key = 'PB' AND labels.name = 'saved-filter-label'",
          )
          .get() as { id: string }
      ).id;
      const restoredProjectId = (
        fresh.query("SELECT id FROM projects WHERE name = 'Saved filter project'").get() as {
          id: string;
        }
      ).id;
      const restoredMilestoneId = (
        fresh.query("SELECT id FROM milestones WHERE name = 'Saved filter milestone'").get() as {
          id: string;
        }
      ).id;
      const restoredCycleId = (
        fresh.query("SELECT id FROM cycles WHERE name = 'Saved filter cycle'").get() as {
          id: string;
        }
      ).id;
      const restoredIssueId = (
        fresh.query("SELECT id FROM issues WHERE title = 'Saved filter issue'").get() as {
          id: string;
        }
      ).id;
      expect(JSON.parse(String(row.filter_json))).toEqual({
        team: { eq: restoredTeamId },
        state: { eq: restoredStateId },
        assignee: { eq: restoredActorId },
        labels: { includes: restoredLabelId, includesAll: [restoredLabelId] },
        project: { eq: restoredProjectId },
        milestone: { eq: restoredMilestoneId },
        cycle: { eq: restoredCycleId },
        parent: { eq: restoredIssueId },
        and: [{ creator: { in: [restoredActorId] } }],
        or: [{ team: { eq: restoredTeamId } }],
      });
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acota las saved views al team en un export parcial", async () => {
    const other = await gql(
      app,
      `mutation { teamCreate(input: { name: "Other saved views team", key: "OTH" }) { team { id } } }`,
    );
    const otherId = other.data!.teamCreate.team.id as string;
    await gql(
      app,
      `mutation($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) { savedView { id } }
      }`,
      {
        input: {
          name: "Do not export me",
          scope: "TEAM",
          teamId: otherId,
          filter: { team: { eq: otherId } },
        },
      },
    );

    const dir = mkdtempSync(join(tmpdir(), "pb-partial-views-"));
    try {
      exportBoard(app.db, dir, { teamKey: "PB" });
      const raw = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "saved-views.json"), "utf8"),
      ) as Array<Record<string, unknown>>;
      expect(raw.map((view) => view.name)).toEqual(["Export me"]);

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      expect(() => rebuildFromRepo(fresh, dir, { allowPartial: true })).not.toThrow();
      expect(fresh.query("SELECT key FROM teams ORDER BY key").all()).toEqual([{ key: "PB" }]);
      expect(fresh.query("SELECT name FROM saved_views").all()).toEqual([{ name: "Export me" }]);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rechaza con diagnóstico los exports legacy que contienen UUIDs de filtros", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-legacy-views-"));
    try {
      exportBoard(app.db, dir);
      const path = join(dir, ".prime-board", "meta", "saved-views.json");
      const views = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, any>>;
      views[0]!.filter.team.eq = "01aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
      writeFileSync(path, JSON.stringify(views));

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      expect(() => rebuildFromRepo(fresh, dir)).toThrow(
        /Saved view "Export me" filter \.team\.eq contains unknown teams reference/,
      );
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
