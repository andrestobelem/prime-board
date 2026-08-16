import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { rebuildFromRepo } from "./importer.ts";
import { mergeLinearExportWithRepo } from "./linear-merge.ts";
import type { LinearExport } from "./linear-repo-export.ts";

const source: LinearExport = {
  workspace: { id: "w", name: "W" },
  actors: [{ id: "a", name: "admin", type: "human" }],
  teams: [
    { id: "t", key: "AT", name: "Linear", states: [{ id: "s", name: "Todo", type: "unstarted" }] },
  ],
  labels: [],
  projects: [],
  comments: [],
  relations: [],
  issues: [
    {
      id: "linear-1",
      identifier: "AT-1",
      number: 1,
      title: "Linear",
      teamId: "t",
      stateId: "s",
      creatorId: "a",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
};

function writeLocalRepo(root: string): void {
  const base = join(root, ".prime-board");
  for (const folder of ["meta", "issues", "log"])
    mkdirSync(join(base, folder), { recursive: true });
  writeFileSync(join(base, "meta", "workspace.json"), JSON.stringify({ name: "W", urlKey: "w" }));
  writeFileSync(
    join(base, "meta", "actors.json"),
    JSON.stringify([
      { name: "admin", email: null, type: "human" },
      { name: "claude", email: null, type: "agent" },
    ]),
  );
  writeFileSync(join(base, "meta", "workspace-labels.json"), "[]");
  writeFileSync(
    join(base, "meta", "projects.json"),
    JSON.stringify([
      {
        name: "Local",
        description: null,
        state: "started",
        lead: "claude",
        targetDate: null,
        archived: false,
        teams: ["AT"],
        milestones: [],
      },
    ]),
  );
  writeFileSync(
    join(base, "meta", "teams.json"),
    JSON.stringify([
      {
        key: "AT",
        name: "prime-board dev",
        description: null,
        defaultState: "Todo",
        states: [{ name: "Todo", type: "unstarted", color: "#aaa", position: 0 }],
        labels: [],
      },
    ]),
  );
  for (const [id, title] of [
    ["AT-1", "Linear"],
    ["AT-2", "Local"],
  ] as const) {
    writeFileSync(
      join(base, "issues", `${id}.md`),
      `---\nid: ${id}\ntitle: ${title}\nteam: AT\nstate: Todo\npriority: 0\nassignee: null\ncreator: ${title === "Local" ? "claude" : "admin"}\nparent: null\nproject: ${title === "Local" ? "Local" : "null"}\nlabels: []\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01\narchivedAt: null\n---\n\n# ${title}\n`,
    );
    writeFileSync(
      join(base, "log", `${id}.jsonl`),
      JSON.stringify({
        actor: title === "Local" ? "claude" : "admin",
        issue: id,
        type: "created",
        ts: "2026-01-01",
        payload: {
          title,
          description: null,
          team: "AT",
          number: Number(id.slice(3)),
          priority: 0,
          state: "Todo",
          assignee: null,
          parent: null,
          project: title === "Local" ? "Local" : null,
          milestone: null,
        },
      }) + "\n",
    );
  }
  writeFileSync(
    join(base, "issues", "AT-3.md"),
    "---\nid: AT-3\ntitle: Nieto\nteam: AT\nstate: Todo\npriority: 0\nassignee: null\ncreator: claude\nparent: AT-2\nproject: Local\nlabels: []\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01\narchivedAt: null\n---\n\n# Nieto\n",
  );
  writeFileSync(
    join(base, "log", "AT-3.jsonl"),
    JSON.stringify({
      actor: "claude",
      issue: "AT-3",
      type: "created",
      ts: "2026-01-01",
      payload: {
        title: "Nieto",
        description: null,
        team: "AT",
        number: 3,
        priority: 0,
        state: "Todo",
        assignee: null,
        parent: "AT-2",
        project: "Local",
        milestone: null,
      },
    }) + "\n",
  );
}

describe("mergeLinearExportWithRepo", () => {
  it("conserva Linear en AT y rekeyea el ticket local colisionado a PRB", () => {
    const local = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-local-"));
    const output = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-out-"));
    try {
      writeLocalRepo(local);
      const result = mergeLinearExportWithRepo(source, local, output);
      expect(result.rekeyed).toEqual({ "AT-2": "PRB-2", "AT-3": "PRB-3" });
      expect(readFileSync(join(output, ".prime-board", "issues", "AT-1.md"), "utf8")).toContain(
        "title: Linear",
      );
      expect(readFileSync(join(output, ".prime-board", "issues", "PRB-2.md"), "utf8")).toContain(
        "team: PRB",
      );
      const teams = JSON.parse(
        readFileSync(join(output, ".prime-board", "meta", "teams.json"), "utf8"),
      );
      expect(teams.map((team: any) => team.key).sort()).toEqual(["AT", "PRB"]);
      const db = new Database(":memory:", { strict: true });
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db);
      expect(rebuildFromRepo(db, output).issues).toBe(3);
      db.close();
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });
});
