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
        }) { cycle { id number } }
      }`,
      { teamId },
    );
    const cycle1 = c1.data!.cycleCreate.cycle.id;
    const cycle1Number = c1.data!.cycleCreate.cycle.number;

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
        }) { cycle { id number } }
      }`,
      { teamId },
    );
    const cycle2 = c2.data!.cycleCreate.cycle.id;
    const cycle2Number = c2.data!.cycleCreate.cycle.number;

    const carried = await gql(
      app,
      `mutation($from: ID!, $to: ID!) {
        cycleCarryOver(fromCycleId: $from, toCycleId: $to) { movedIssues }
      }`,
      { from: cycle1, to: cycle2 },
    );
    expect(carried.data!.cycleCarryOver.movedIssues).toBe(1);

    const activity = await gql(
      app,
      `query($id: ID!) { issue(id: $id) { activity { type actor { name } payload } } }`,
      { id: openIssue.data!.issueCreate.issue.id },
    );
    const cycleChanges = activity.data!.issue.activity.filter(
      (event: any) => event.type === "cycle_changed",
    );
    expect(cycleChanges).toEqual([
      {
        type: "cycle_changed",
        actor: { name: "admin" },
        payload: { from: null, to: `PB/${cycle1Number}` },
      },
      {
        type: "cycle_changed",
        actor: { name: "admin" },
        payload: { from: `PB/${cycle1Number}`, to: `PB/${cycle2Number}` },
      },
    ]);

    const inC2 = await gql(
      app,
      `query($id: ID!) {
        issues(filter: { cycle: { eq: $id } }) { nodes { title } }
      }`,
      { id: cycle2 },
    );
    expect(inC2.data!.issues.nodes).toEqual([{ title: "Open" }]);
  });

  it("registra el actor y la desasignación al borrar un cycle", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const cycle = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "DeleteActivity", startsAt: "2026-11-01", endsAt: "2026-11-14"
        }) { cycle { id number } }
      }`,
      { teamId: team.data!.team.id },
    );
    const cycleId = cycle.data!.cycleCreate.cycle.id;
    const cycleNumber = cycle.data!.cycleCreate.cycle.number;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Deleted cycle issue" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    await gql(
      app,
      `mutation($id: ID!, $cycleId: ID!) { issueUpdate(id: $id, input: { cycleId: $cycleId }) { success } }`,
      { id: issueId, cycleId },
    );
    const deleted = await gql(app, `mutation($id: ID!) { cycleDelete(id: $id) { success } }`, {
      id: cycleId,
    });
    expect(deleted.data!.cycleDelete.success).toBe(true);

    const activity = await gql(
      app,
      `query($id: ID!) { issue(id: $id) { activity { type actor { name } payload } } }`,
      { id: issueId },
    );
    const cycleChanges = activity.data!.issue.activity.filter(
      (event: any) => event.type === "cycle_changed",
    );
    expect(cycleChanges.at(-1)).toEqual({
      type: "cycle_changed",
      actor: { name: "admin" },
      payload: { from: `PB/${cycleNumber}`, to: null },
    });
  });

  it("preserva las actividades de carry-over en export → rebuild", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const first = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "ActivitySource", startsAt: "2027-01-01", endsAt: "2027-01-14"
        }) { cycle { id number } }
      }`,
      { teamId: team.data!.team.id },
    );
    const second = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "ActivityTarget", startsAt: "2027-01-15", endsAt: "2027-01-28"
        }) { cycle { id number } }
      }`,
      { teamId: team.data!.team.id },
    );
    const sourceId = first.data!.cycleCreate.cycle.id;
    const sourceNumber = first.data!.cycleCreate.cycle.number;
    const targetId = second.data!.cycleCreate.cycle.id;
    const targetNumber = second.data!.cycleCreate.cycle.number;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Carry-over activity" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    await gql(
      app,
      `mutation($id: ID!, $cycleId: ID!) { issueUpdate(id: $id, input: { cycleId: $cycleId }) { success } }`,
      { id: issueId, cycleId: sourceId },
    );
    await gql(
      app,
      `mutation($from: ID!, $to: ID!) { cycleCarryOver(fromCycleId: $from, toCycleId: $to) { movedIssues } }`,
      { from: sourceId, to: targetId },
    );

    const dir = mkdtempSync(join(tmpdir(), "pb-cycle-activity-"));
    try {
      exportBoard(app.db, dir);
      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);
      const events = fresh
        .query(
          `SELECT a.payload, actors.name AS actor
           FROM activity a
           JOIN actors ON actors.id = a.actor_id
           JOIN issues ON issues.id = a.issue_id
           WHERE issues.title = ?1 AND a.type = 'cycle_changed'
           ORDER BY a.created_at, a.id`,
        )
        .all("Carry-over activity") as Array<{ payload: string; actor: string }>;
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.actor === "admin")).toBe(true);
      const payloads = events.map((event) => JSON.parse(event.payload));
      const referenceFor = (cycleId: string) =>
        (
          fresh
            .query(
              `SELECT teams.key || '/' || cycles.number AS ref
               FROM cycles JOIN teams ON teams.id = cycles.team_id WHERE cycles.id = ?1`,
            )
            .get(cycleId) as { ref: string }
        ).ref;
      expect(
        payloads.some(
          (payload) => payload.from === null && referenceFor(payload.to) === `PB/${sourceNumber}`,
        ),
      ).toBe(true);
      expect(
        payloads.some(
          (payload) =>
            payload.from !== null &&
            referenceFor(payload.from) === `PB/${sourceNumber}` &&
            referenceFor(payload.to) === `PB/${targetNumber}`,
        ),
      ).toBe(true);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
