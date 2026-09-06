// PRB-391: relaciones nuevas sobreviven al snapshot local-first.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";
import { migrate } from "../db/database.ts";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("planning settings export", () => {
  it("reconstruye Project members/dependencies e Initiative properties", async () => {
    const team = (await gql(app, `{ team(key: "PB") { id } }`)).data!.team.id as string;
    const actor = (
      await gql(
        app,
        `mutation { actorCreate(input: { name: "roundtrip-planning", type: AGENT }) { actor { id } } }`,
      )
    ).data!.actorCreate.actor.id as string;
    const label = (
      await gql(
        app,
        `mutation { labelCreate(input: { name: "roadmap", color: "#fff" }) { label { id } } }`,
      )
    ).data!.labelCreate.label.id as string;
    const source = (
      await gql(
        app,
        `mutation($team: ID!, $actor: ID!) { projectCreate(input: { name: "Roundtrip source", teamIds: [$team], memberIds: [$actor], startDate: "2026-09-01" }) { project { id } } }`,
        { team, actor },
      )
    ).data!.projectCreate.project.id as string;
    const target = (
      await gql(
        app,
        `mutation($team: ID!) { projectCreate(input: { name: "Roundtrip target", teamIds: [$team] }) { project { id } } }`,
        { team },
      )
    ).data!.projectCreate.project.id as string;
    await gql(
      app,
      `mutation($id: ID!, $target: ID!) { projectUpdate(id: $id, input: { dependencyIds: [$target] }) { success } }`,
      { id: source, target },
    );
    await gql(
      app,
      `mutation($team: ID!, $project: ID!, $label: ID!) { initiativeCreate(input: { name: "Roundtrip initiative", priority: 3, leadTeamId: $team, labelIds: [$label], resources: [{ name: "ops" }], projectIds: [$project], teamIds: [$team] }) { success } }`,
      { team, project: source, label },
    );
    const dir = mkdtempSync(join("/tmp", "pb-prb391-"));
    const rebuilt = new Database(":memory:", { strict: true });
    rebuilt.exec("PRAGMA foreign_keys = ON;");
    migrate(rebuilt);
    try {
      exportBoard(app.db, dir);
      rebuildFromRepo(rebuilt, dir);
      expect(
        (rebuilt.query("SELECT count(*) AS count FROM project_members").get() as { count: number })
          .count,
      ).toBe(1);
      expect(
        (
          rebuilt.query("SELECT count(*) AS count FROM project_dependencies").get() as {
            count: number;
          }
        ).count,
      ).toBe(1);
      const initiative = rebuilt
        .query("SELECT priority, lead_team_id, resources_json FROM initiatives WHERE name = ?1")
        .get("Roundtrip initiative") as {
        priority: number;
        lead_team_id: string;
        resources_json: string;
      };
      expect(initiative.priority).toBe(3);
      expect(JSON.parse(initiative.resources_json)).toEqual([{ name: "ops" }]);
      expect(
        (
          rebuilt.query("SELECT count(*) AS count FROM initiative_labels").get() as {
            count: number;
          }
        ).count,
      ).toBe(1);
    } finally {
      rebuilt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
