// PRB-374: el nombre del Workspace viaja por export y rebuild.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";
import { createTestApp, gql } from "../test-helpers.ts";

describe("Workspace export/rebuild", () => {
  const app = createTestApp();
  const dir = mkdtempSync(join(tmpdir(), "pb-workspace-roundtrip-"));

  afterAll(() => {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("conserva nombre, urlKey, teams e issues", async () => {
    const created = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Workspace roundtrip", dueDate: "2026-06-15" }) { issue { id identifier dueDate } } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data!.issueCreate.issue.dueDate).toBe("2026-06-15");
    const states = (await gql(app, `{ team(key: "PB") { states { id type } } }`)).data!.team.states;
    const started = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) { issueUpdate(id: $id, input: { stateId: $stateId }) { issue { startedAt } } }`,
      {
        id: created.data!.issueCreate.issue.id,
        stateId: states.find((s: any) => s.type === "STARTED").id,
      },
    );
    const completed = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) { issueUpdate(id: $id, input: { stateId: $stateId }) { issue { completedAt } } }`,
      {
        id: created.data!.issueCreate.issue.id,
        stateId: states.find((s: any) => s.type === "COMPLETED").id,
      },
    );
    expect(started.errors).toBeUndefined();
    expect(completed.errors).toBeUndefined();
    const renamed = await gql(
      app,
      `mutation { workspaceUpdate(input: { name: "Exported Workspace" }) { success } }`,
    );
    expect(renamed.errors).toBeUndefined();

    exportBoard(app.db, dir);
    expect(JSON.parse(readFileSync(join(dir, ".prime-board/meta/workspace.json"), "utf8"))).toEqual(
      {
        name: "Exported Workspace",
        urlKey: "prime-board",
      },
    );

    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON;");
    migrate(fresh);
    rebuildFromRepo(fresh, dir);

    const workspace = fresh.query("SELECT id, name, url_key FROM workspace").get() as {
      id: string;
      name: string;
      url_key: string;
    };
    expect(workspace.name).toBe("Exported Workspace");
    expect(workspace.url_key).toBe("prime-board");
    expect(fresh.query("SELECT key FROM teams WHERE key = 'PB'").get()).toEqual({ key: "PB" });
    expect(
      fresh
        .query(
          "SELECT teams.key || '-' || issues.number AS identifier, issues.due_date, issues.started_at, issues.completed_at FROM issues JOIN teams ON teams.id = issues.team_id",
        )
        .get(),
    ).toEqual({
      identifier: created.data!.issueCreate.issue.identifier,
      due_date: "2026-06-15",
      started_at: started.data!.issueUpdate.issue.startedAt,
      completed_at: completed.data!.issueUpdate.issue.completedAt,
    });
    fresh.close();
  });
});
