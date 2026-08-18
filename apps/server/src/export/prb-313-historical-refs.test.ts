import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql } from "../test-helpers.ts";
import { migrate } from "../db/database.ts";
import { deleteCycle, createCycle } from "../domain/cycles.ts";
import { deleteMilestone } from "../domain/milestones.ts";
import { deleteWorkflowState } from "../domain/teams.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";

describe("PRB-313: referencias históricas", () => {
  const app = createTestApp();
  afterAll(() => app.stop());

  it("conserva tombstones de cycle, state y milestone sin UUIDs", async () => {
    const team = (await gql(app, `{ team(key: "PB") { id states { id name } } }`)).data!.team;
    const actor = (
      app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }
    ).id;
    const cycle = await gql(
      app,
      `mutation($team: ID!) { cycleCreate(input: { teamId: $team, name: "Old", startsAt: "2027-01-01", endsAt: "2027-01-14" }) { cycle { id number } } }`,
      { team: team.id },
    );
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "History" }) { issue { id identifier } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id as string;
    await gql(
      app,
      `mutation($issue: ID!, $cycle: ID!) { issueUpdate(id: $issue, input: { cycleId: $cycle }) { success } }`,
      {
        issue: issueId,
        cycle: cycle.data!.cycleCreate.cycle.id,
      },
    );
    deleteCycle(app.db, actor, cycle.data!.cycleCreate.cycle.id);
    const recreated = createCycle(app.db, {
      teamId: team.id,
      name: "New",
      startsAt: "2027-02-01",
      endsAt: "2027-02-14",
    });
    expect(recreated.number).toBe(cycle.data!.cycleCreate.cycle.number + 1);

    const todo = team.states.find((state: any) => state.name === "Todo")!;
    const backlog = team.states.find((state: any) => state.name === "Backlog")!;
    await gql(
      app,
      `mutation($issue: ID!, $state: ID!) { issueUpdate(id: $issue, input: { stateId: $state }) { success } }`,
      {
        issue: issueId,
        state: todo.id,
      },
    );
    deleteWorkflowState(app.db, actor, todo.id, backlog.id);

    const project = await gql(
      app,
      `mutation { projectCreate(input: { name: "History project", teamIds: ["${team.id}"] }) { project { id } } }`,
    );
    const milestone = await gql(
      app,
      `mutation($project: ID!) { milestoneCreate(input: { projectId: $project, name: "Old milestone" }) { milestone { id } } }`,
      {
        project: project.data!.projectCreate.project.id,
      },
    );
    await gql(
      app,
      `mutation($issue: ID!, $project: ID!, $milestone: ID!) { issueUpdate(id: $issue, input: { projectId: $project, milestoneId: $milestone }) { success } }`,
      {
        issue: issueId,
        project: project.data!.projectCreate.project.id,
        milestone: milestone.data!.milestoneCreate.milestone.id,
      },
    );
    deleteMilestone(app.db, actor, milestone.data!.milestoneCreate.milestone.id);

    const dir = mkdtempSync(join(tmpdir(), "pb-prb313-"));
    try {
      exportBoard(app.db, dir);
      const log = readFileSync(join(dir, ".prime-board", "log", "PB-1.jsonl"), "utf8");
      expect(log).toContain('"PB/1"');
      expect(log).toContain('"PB/Todo"');
      expect(log).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);
      const payloads = fresh.query("SELECT payload FROM activity").all() as Array<{
        payload: string;
      }>;
      expect(payloads.some((row) => row.payload.includes("PB/Todo"))).toBe(true);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
