import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { rebuildFromRepo } from "./importer.ts";
import { writeLinearExportToRepo, type LinearExport } from "./linear-repo-export.ts";

const source: LinearExport = {
  workspace: { id: "workspace-1", name: "Workspace", urlKey: "workspace" },
  actors: [
    { id: "actor-1", name: "Andrés", email: "andres@example.com", type: "human" },
    { id: "actor-2", name: "agent", type: "agent" },
  ],
  teams: [
    {
      id: "team-1",
      key: "AT",
      name: "Andrestobelem",
      description: "Equipo",
      states: [
        { id: "state-1", name: "Backlog", type: "backlog", color: "#aaa", position: 0 },
        { id: "state-2", name: "Done", type: "completed", color: "#555", position: 1 },
      ],
    },
  ],
  labels: [{ id: "label-1", name: "Feature", color: "#fff", teamId: "team-1" }],
  projects: [
    {
      id: "project-1",
      name: "Proyecto",
      description: "Descripción",
      state: "started",
      leadId: "actor-1",
      targetDate: null,
      archivedAt: null,
      teamIds: ["team-1"],
      milestones: [
        { id: "milestone-1", name: "M1", description: null, targetDate: null, position: 0 },
      ],
    },
  ],
  issues: [
    {
      id: "issue-1",
      identifier: "AT-1",
      number: 1,
      title: "Padre",
      description: "desc",
      teamId: "team-1",
      stateId: "state-1",
      priority: 2,
      assigneeId: "actor-2",
      creatorId: "actor-1",
      parentId: null,
      projectId: "project-1",
      milestoneId: "milestone-1",
      labelIds: ["label-1"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      stateHistory: [{ stateId: "state-1", startedAt: "2026-01-01T00:00:00.000Z" }],
    },
    {
      id: "issue-2",
      identifier: "AT-2",
      number: 2,
      title: "Hijo",
      description: null,
      teamId: "team-1",
      stateId: "state-2",
      priority: 0,
      assigneeId: null,
      creatorId: "actor-1",
      parentId: "issue-1",
      projectId: "project-1",
      milestoneId: null,
      labelIds: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      archivedAt: null,
      stateHistory: [
        { stateId: "state-1", startedAt: "2026-01-02T00:00:00.000Z" },
        { stateId: "state-2", startedAt: "2026-01-03T00:00:00.000Z" },
      ],
    },
  ],
  comments: [
    {
      id: "comment-1",
      issueId: "issue-1",
      authorId: "actor-2",
      body: "evidencia",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  relations: [
    {
      issueId: "issue-2",
      relatedIssueId: "issue-1",
      type: "blocked_by",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
};

describe("writeLinearExportToRepo", () => {
  it("convierte un Linear export al formato repo y permite reconstruirlo", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-import-"));
    try {
      const result = writeLinearExportToRepo(source, root);
      expect(result).toMatchObject({ issues: 2, comments: 1, conflicts: [], losses: [] });
      expect(existsSync(join(root, ".prime-board", "meta", "source-map.json"))).toBe(true);
      expect(
        readFileSync(join(root, ".prime-board", "meta", "migration-report.json"), "utf8"),
      ).toContain('"events":');
      expect(readFileSync(join(root, ".prime-board", "issues", "AT-1.md"), "utf8")).toContain(
        "assignee: agent",
      );
      expect(readFileSync(join(root, ".prime-board", "log", "AT-2.jsonl"), "utf8")).toContain(
        '"type":"state_changed"',
      );

      const db = new Database(":memory:", { strict: true });
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db);
      const rebuilt = rebuildFromRepo(db, root);
      expect(rebuilt).toMatchObject({ issues: 2, comments: 1 });
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM issues WHERE team_id = (SELECT id FROM teams WHERE key = 'AT')",
          )
          .get(),
      ).toEqual({ n: 2 });
      expect(db.query("SELECT count(*) AS n FROM issue_relations").get()).toEqual({ n: 1 });
      expect(db.query("SELECT count(*) AS n FROM comments").get()).toEqual({ n: 1 });
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("en dry-run no escribe archivos", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-plan-"));
    try {
      const result = writeLinearExportToRepo(source, root, { dryRun: true });
      expect(result.issues).toBe(2);
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explicita pérdidas y convierte artefactos a enlaces", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-loss-"));
    const withUnsupported: LinearExport = {
      ...source,
      issues: [
        {
          ...source.issues[0]!,
          dueDate: "2026-02-01",
          attachments: [{ url: "https://example.test/a", title: "artefacto" }],
        },
      ],
      projects: [
        { ...source.projects[0]!, documents: [{ url: "https://example.test/d", title: "doc" }] },
      ],
      relations: [],
    };
    try {
      const dry = writeLinearExportToRepo(withUnsupported, root, { dryRun: true });
      expect(dry.losses).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "UNREPRESENTED_DUE_DATE" })]),
      );
      expect(dry.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "LINKED_ISSUE_ARTIFACTS" })]),
      );
      expect(() => writeLinearExportToRepo(withUnsupported, root)).toThrow(/unapproved loss/);
      const applied = writeLinearExportToRepo(withUnsupported, root, { allowLosses: true });
      expect(applied.losses.length).toBeGreaterThan(0);
      expect(readFileSync(join(root, ".prime-board", "issues", "AT-1.md"), "utf8")).toContain(
        "https://example.test/a",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
