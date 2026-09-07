// Regresión PRB-383: metadata, estado reservado y relación duplicate_of sobreviven export/rebuild.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../db/database.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let dir: string;
let sourceId: string;
let sourceIdentifier: string;

beforeAll(async () => {
  app = createTestApp();
  dir = mkdtempSync(join(tmpdir(), "pb-workflow-roundtrip-"));
  const team = await gql(app, `{ team(key: "PB") { id states { id name type isReserved } } }`);
  const teamId = team.data!.team.id;
  const doneId = team.data!.team.states.find((state: any) => state.type === "COMPLETED").id;
  await gql(
    app,
    `mutation($teamId: ID!, $doneId: ID!) {
      teamUpdate(id: $teamId, input: {
        autoClosePeriod: 14, autoArchivePeriod: 30, autoCloseStateId: $doneId,
        autoCloseParentIssues: false, autoCloseChildIssues: true
      }) { success }
    }`,
    { teamId, doneId },
  );
  const source = await gql(
    app,
    `mutation { issueCreate(input: { teamKey: "PB", title: "Duplicate source" }) { issue { id identifier } } }`,
  );
  const canonical = await gql(
    app,
    `mutation { issueCreate(input: { teamKey: "PB", title: "Canonical issue" }) { issue { id identifier } } }`,
  );
  sourceId = source.data!.issueCreate.issue.id;
  sourceIdentifier = source.data!.issueCreate.issue.identifier;
  const relation = await gql(
    app,
    `mutation($source: ID!, $canonical: ID!) {
      issueRelationCreate(input: { issueId: $source, relatedIssueId: $canonical, type: DUPLICATE_OF }) { success }
    }`,
    { source: sourceId, canonical: canonical.data!.issueCreate.issue.id },
  );
  expect(relation.errors).toBeUndefined();
  exportBoard(app.db, dir);
});

afterAll(() => {
  app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("workflow export/rebuild", () => {
  it("preserves automation settings, descriptions, and Duplicate metadata", () => {
    const teams = JSON.parse(
      readFileSync(join(dir, ".prime-board/meta/teams.json"), "utf8"),
    ) as Array<any>;
    const team = teams.find((entry) => entry.key === "PB");
    expect(team).toMatchObject({
      autoClosePeriod: 14,
      autoArchivePeriod: 30,
      autoCloseState: "Done",
      autoCloseParentIssues: false,
      autoCloseChildIssues: true,
    });
    expect(team.states.find((state: any) => state.name === "Duplicate")).toMatchObject({
      type: "canceled",
      description: "System-managed status for duplicate issues.",
      isReserved: true,
    });
    expect(team.states.every((state: any) => typeof state.description === "string")).toBe(true);
  });

  it("rebuilds Duplicate from a historical export without the reserved state", () => {
    const teamsPath = join(dir, ".prime-board/meta/teams.json");
    const teams = JSON.parse(readFileSync(teamsPath, "utf8")) as Array<any>;
    const team = teams.find((entry) => entry.key === "PB");
    team.states = team.states.filter((state: any) => state.name !== "Duplicate");
    writeFileSync(teamsPath, JSON.stringify(teams, null, 2) + "\n");

    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON;");
    migrate(fresh);
    rebuildFromRepo(fresh, dir);

    const rebuiltTeam = fresh
      .query(
        "SELECT auto_close_period, auto_archive_period, auto_close_parent_issues, auto_close_child_issues, auto_close_state_id FROM teams WHERE key = 'PB'",
      )
      .get() as {
      auto_close_period: number;
      auto_archive_period: number;
      auto_close_parent_issues: number;
      auto_close_child_issues: number;
      auto_close_state_id: string;
    };
    expect(rebuiltTeam.auto_close_period).toBe(14);
    expect(rebuiltTeam.auto_archive_period).toBe(30);
    expect(rebuiltTeam.auto_close_parent_issues).toBe(0);
    expect(rebuiltTeam.auto_close_child_issues).toBe(1);
    expect(
      fresh
        .query("SELECT type FROM workflow_states WHERE id = ?1")
        .get(rebuiltTeam.auto_close_state_id),
    ).toEqual({ type: "completed" });
    expect(
      fresh
        .query(
          "SELECT is_reserved FROM workflow_states WHERE team_id = (SELECT id FROM teams WHERE key = 'PB') AND name = 'Duplicate'",
        )
        .get(),
    ).toEqual({ is_reserved: 1 });
    expect(
      fresh
        .query(
          "SELECT state_id FROM issues JOIN teams ON teams.id = issues.team_id WHERE teams.key || '-' || issues.number = ?1",
        )
        .get(sourceIdentifier),
    ).toEqual(
      fresh
        .query("SELECT id AS state_id FROM workflow_states WHERE name = 'Duplicate' LIMIT 1")
        .get(),
    );
    expect(
      fresh
        .query("SELECT count(*) AS count FROM issue_relations WHERE type = 'duplicate_of'")
        .get(),
    ).toEqual({ count: 1 });
    fresh.close();
  });
});
