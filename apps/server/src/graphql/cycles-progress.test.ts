// PRB-211: progreso, carry-over y export de ciclos.
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

describe("cycle progress and carry-over", () => {
  it("reporta progreso y hace carry-over al siguiente ciclo", async () => {
    const team = await gql(app, `{ team(key: "PB") { id states { id type } } }`);
    const teamId = team.data!.team.id;
    const todo = team.data!.team.states.find((s: { type: string }) => s.type === "UNSTARTED").id;
    const done = team.data!.team.states.find((s: { type: string }) => s.type === "COMPLETED").id;

    const c1 = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "C1", startsAt: "2026-08-01", endsAt: "2026-08-14", state: ACTIVE
        }) { cycle { id } }
      }`,
      { teamId },
    );
    const cycle1 = c1.data!.cycleCreate.cycle.id;

    const openIssue = await gql(
      app,
      `mutation($stateId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Open", stateId: $stateId }) {
          issue { id }
        }
      }`,
      { stateId: todo },
    );
    // assign to cycle
    await gql(
      app,
      `mutation($id: ID!, $cycleId: ID!) {
        issueUpdate(id: $id, input: { cycleId: $cycleId }) { issue { id } }
      }`,
      { id: openIssue.data!.issueCreate.issue.id, cycleId: cycle1 },
    );

    const closedIssue = await gql(
      app,
      `mutation($stateId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Closed", stateId: $stateId }) {
          issue { id }
        }
      }`,
      { stateId: done },
    );
    await gql(
      app,
      `mutation($id: ID!, $cycleId: ID!) {
        issueUpdate(id: $id, input: { cycleId: $cycleId }) { issue { id } }
      }`,
      { id: closedIssue.data!.issueCreate.issue.id, cycleId: cycle1 },
    );

    const progress = await gql(
      app,
      `query($id: ID!) {
        cycle(id: $id) { id progress completedIssues totalIssues }
      }`,
      { id: cycle1 },
    );
    expect(progress.data!.cycle).toMatchObject({
      totalIssues: 2,
      completedIssues: 1,
      progress: 0.5,
    });

    const c2 = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "C2", startsAt: "2026-08-15", endsAt: "2026-08-28"
        }) { cycle { id } }
      }`,
      { teamId },
    );
    const cycle2 = c2.data!.cycleCreate.cycle.id;

    const carried = await gql(
      app,
      `mutation($from: ID!, $to: ID!) {
        cycleCarryOver(fromCycleId: $from, toCycleId: $to) { movedIssues }
      }`,
      { from: cycle1, to: cycle2 },
    );
    expect(carried.data!.cycleCarryOver.movedIssues).toBe(1);

    const inC2 = await gql(
      app,
      `query($id: ID!) {
        issues(filter: { cycle: { eq: $id } }) { nodes { title } }
      }`,
      { id: cycle2 },
    );
    expect(inC2.data!.issues.nodes).toEqual([{ title: "Open" }]);
  });

  it("exporta e importa ciclos", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "ExportCycle", startsAt: "2026-09-01", endsAt: "2026-09-14"
        }) { cycle { id } }
      }`,
      { teamId: team.data!.team.id },
    );

    const dir = mkdtempSync(join(tmpdir(), "pb-cycles-"));
    try {
      exportBoard(app.db, dir);
      const raw = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "cycles.json"), "utf8"),
      );
      expect(raw.some((c: { name: string }) => c.name === "ExportCycle")).toBe(true);

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);
      const rows = fresh.query("SELECT name FROM cycles WHERE name = 'ExportCycle'").all();
      expect(rows).toHaveLength(1);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
