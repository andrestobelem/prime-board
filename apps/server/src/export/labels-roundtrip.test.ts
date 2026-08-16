// PRB-236: las labels se referencian por scope, no solo por nombre.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { openDatabase } from "../db/database.ts";
import { createTestApp, gql } from "../test-helpers.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("scoped label export/import", () => {
  it("preserves homonymous team and workspace labels through rebuild", async () => {
    const otherTeam = await gql(
      app,
      `mutation { teamCreate(input: { name: "Other", key: "OT" }) { team { id } } }`,
    );
    const otherTeamId = otherTeam.data!.teamCreate.team.id;
    const pbTeam = await gql(app, `{ team(key: "PB") { id } }`);
    const pbTeamId = pbTeam.data!.team.id;

    const pbLabel = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "bug", color: "#111111", teamId: $teamId }) { label { id } } }`,
      { teamId: pbTeamId },
    );
    const otLabel = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "bug", color: "#222222", teamId: $teamId }) { label { id } } }`,
      { teamId: otherTeamId },
    );
    const workspaceLabel = await gql(
      app,
      `mutation { labelCreate(input: { name: "bug", color: "#333333" }) { label { id } } }`,
    );

    await gql(
      app,
      `mutation($labels: [ID!]) { issueCreate(input: { teamKey: "PB", title: "PB label issue", labelIds: $labels }) { issue { id } } }`,
      { labels: [pbLabel.data!.labelCreate.label.id, workspaceLabel.data!.labelCreate.label.id] },
    );
    await gql(
      app,
      `mutation($labels: [ID!]) { issueCreate(input: { teamKey: "OT", title: "OT label issue", labelIds: $labels }) { issue { id } } }`,
      { labels: [otLabel.data!.labelCreate.label.id, workspaceLabel.data!.labelCreate.label.id] },
    );

    const dir = mkdtempSync(join(tmpdir(), "pb-scoped-labels-"));
    const rebuilt = openDatabase(":memory:");
    try {
      exportBoard(app.db, dir);
      const readLabels = (identifier: string) => {
        const raw = readFileSync(join(dir, ".prime-board", "issues", `${identifier}.md`), "utf8");
        const frontMatter = raw.match(/^---\n([\s\S]*?)\n---/);
        return (
          parseYaml(frontMatter![1]!).labels as Array<{ name: string; team: string | null }>
        ).sort((a, b) =>
          `${a.team ?? "workspace"}/${a.name}`.localeCompare(`${b.team ?? "workspace"}/${b.name}`),
        );
      };
      expect(readLabels("PB-1")).toEqual([
        { name: "bug", team: "PB" },
        { name: "bug", team: null },
      ]);
      expect(readLabels("OT-1")).toEqual([
        { name: "bug", team: "OT" },
        { name: "bug", team: null },
      ]);

      rebuildFromRepo(rebuilt, dir);
      const rows = rebuilt
        .query(
          `SELECT issueTeams.key AS issue_team, labelTeams.key AS label_team,
                  labels.name, labels.color
           FROM issue_labels
           JOIN issues ON issues.id = issue_labels.issue_id
           JOIN teams issueTeams ON issueTeams.id = issues.team_id
           JOIN labels ON labels.id = issue_labels.label_id
           LEFT JOIN teams labelTeams ON labelTeams.id = labels.team_id
           ORDER BY issueTeams.key, labelTeams.key, labels.name, labels.color`,
        )
        .all() as Array<{
        issue_team: string;
        label_team: string | null;
        name: string;
        color: string;
      }>;
      expect(rows).toEqual([
        { issue_team: "OT", label_team: null, name: "bug", color: "#333333" },
        { issue_team: "OT", label_team: "OT", name: "bug", color: "#222222" },
        { issue_team: "PB", label_team: null, name: "bug", color: "#333333" },
        { issue_team: "PB", label_team: "PB", name: "bug", color: "#111111" },
      ]);
    } finally {
      rebuilt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
