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
      `mutation { issueCreate(input: { teamKey: "PB", title: "Workspace roundtrip" }) { issue { identifier } } }`,
    );
    expect(created.errors).toBeUndefined();
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
          "SELECT teams.key || '-' || issues.number AS identifier FROM issues JOIN teams ON teams.id = issues.team_id",
        )
        .get(),
    ).toEqual({ identifier: created.data!.issueCreate.issue.identifier });
    fresh.close();
  });
});
