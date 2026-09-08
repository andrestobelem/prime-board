import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { rebuildFromRepo } from "./importer.ts";
import { exportBoard } from "./exporter.ts";
import { writeLinearExportToRepo, type LinearExport } from "./linear-repo-export.ts";

const source: LinearExport = {
  workspace: { id: "00000000-0000-4000-8000-000000000001", name: "Workspace", urlKey: "workspace" },
  actors: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Andrés",
      email: "andres@example.com",
      type: "human",
    },
    { id: "00000000-0000-4000-8000-000000000003", name: "agent", type: "agent" },
  ],
  teams: [
    {
      id: "00000000-0000-4000-8000-000000000004",
      key: "AT",
      name: "Andrestobelem",
      description: "Equipo",
      states: [
        {
          id: "00000000-0000-4000-8000-000000000005",
          name: "Backlog",
          type: "backlog",
          color: "#aaa",
          position: 0,
        },
        {
          id: "00000000-0000-4000-8000-000000000006",
          name: "Done",
          type: "completed",
          color: "#555",
          position: 1,
        },
      ],
      members: [
        { actorId: "00000000-0000-4000-8000-000000000002", role: "owner" },
        { actorId: "00000000-0000-4000-8000-000000000003", role: "member" },
      ],
    },
  ],
  labels: [
    {
      id: "00000000-0000-4000-8000-000000000007",
      name: "Feature",
      color: "#fff",
      teamId: "00000000-0000-4000-8000-000000000004",
    },
  ],
  projects: [
    {
      id: "00000000-0000-4000-8000-000000000008",
      name: "Proyecto",
      description: "Descripción",
      state: "started",
      leadId: "00000000-0000-4000-8000-000000000002",
      targetDate: null,
      archivedAt: null,
      teamIds: ["00000000-0000-4000-8000-000000000004"],
      milestones: [
        {
          id: "00000000-0000-4000-8000-000000000009",
          name: "M1",
          description: null,
          targetDate: null,
          position: 0,
        },
      ],
    },
  ],
  issues: [
    {
      id: "00000000-0000-4000-8000-00000000000a",
      identifier: "AT-1",
      number: 1,
      title: "Padre",
      description: "desc",
      teamId: "00000000-0000-4000-8000-000000000004",
      stateId: "00000000-0000-4000-8000-000000000005",
      priority: 2,
      assigneeId: "00000000-0000-4000-8000-000000000003",
      creatorId: "00000000-0000-4000-8000-000000000002",
      parentId: null,
      projectId: "00000000-0000-4000-8000-000000000008",
      milestoneId: "00000000-0000-4000-8000-000000000009",
      labelIds: ["00000000-0000-4000-8000-000000000007"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      stateHistory: [
        { stateId: "00000000-0000-4000-8000-000000000005", startedAt: "2026-01-01T00:00:00.000Z" },
      ],
    },
    {
      id: "00000000-0000-4000-8000-00000000000b",
      identifier: "AT-2",
      number: 2,
      title: "Hijo",
      description: null,
      teamId: "00000000-0000-4000-8000-000000000004",
      stateId: "00000000-0000-4000-8000-000000000006",
      priority: 0,
      assigneeId: null,
      creatorId: "00000000-0000-4000-8000-000000000002",
      parentId: "00000000-0000-4000-8000-00000000000a",
      projectId: "00000000-0000-4000-8000-000000000008",
      milestoneId: null,
      labelIds: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      archivedAt: null,
      stateHistory: [
        { stateId: "00000000-0000-4000-8000-000000000005", startedAt: "2026-01-02T00:00:00.000Z" },
        { stateId: "00000000-0000-4000-8000-000000000006", startedAt: "2026-01-03T00:00:00.000Z" },
      ],
    },
  ],
  comments: [
    {
      id: "00000000-0000-4000-8000-00000000000c",
      issueId: "00000000-0000-4000-8000-00000000000a",
      authorId: "00000000-0000-4000-8000-000000000003",
      body: "evidencia",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  relations: [
    {
      issueId: "00000000-0000-4000-8000-00000000000b",
      relatedIssueId: "00000000-0000-4000-8000-00000000000a",
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
      expect(
        JSON.parse(readFileSync(join(root, ".prime-board", "meta", "teams.json"), "utf8"))[0]
          .members,
      ).toEqual([
        { actor: "agent", role: "member" },
        { actor: "Andrés", role: "owner" },
      ]);
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

describe("validación del plan Linear", () => {
  it("rechaza IDs que no son UUID antes de escribir, también en la entrada directa", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-invalid-id-"));
    try {
      const invalid: LinearExport = {
        ...source,
        workspace: { ...source.workspace, id: "workspace-invalid" },
      };
      const result = writeLinearExportToRepo(invalid, root, { dryRun: true });
      expect(result.conflicts).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "NON_UUID_SOURCE_ID" })]),
      );
      expect(result.files).toBe(0);
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
      expect(() => writeLinearExportToRepo(invalid, root)).toThrow(/conflict/);
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza Teams sin Workflow States antes de escribir", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-empty-states-"));
    try {
      const invalid: LinearExport = {
        ...source,
        teams: [{ ...source.teams[0]!, states: [] }],
        issues: [],
        projects: [],
        comments: [],
        relations: [],
      };
      const result = writeLinearExportToRepo(invalid, root, { dryRun: true });
      expect(result.conflicts).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "EMPTY_TEAM_STATES" })]),
      );
      expect(result.files).toBe(0);
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza snapshots sin memberships en vez de inferir owners", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-missing-members-"));
    try {
      const teamWithoutMembers = { ...source.teams[0]! };
      delete teamWithoutMembers.members;
      const invalid: LinearExport = { ...source, teams: [teamWithoutMembers] };
      const result = writeLinearExportToRepo(invalid, root, { dryRun: true });
      expect(result.conflicts).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "MISSING_TEAM_MEMBERSHIPS" })]),
      );
      expect(result.files).toBe(0);
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza referencias desconocidas y no escribe durante el dry-run", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-invalid-ref-"));
    try {
      const invalid: LinearExport = {
        ...source,
        teams: [{ ...source.teams[0]!, defaultStateId: "missing-state" }],
        projects: [{ ...source.projects[0]!, leadId: "missing-actor", teamIds: ["missing-team"] }],
      };
      const result = writeLinearExportToRepo(invalid, root, { dryRun: true });
      expect(result.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "UNKNOWN_DEFAULT_STATE" }),
          expect.objectContaining({ code: "UNKNOWN_PROJECT_LEAD" }),
          expect.objectContaining({ code: "UNKNOWN_PROJECT_TEAM" }),
        ]),
      );
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza relaciones self y ciclos de bloqueo antes del staging", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-invalid-rel-"));
    try {
      const invalid: LinearExport = {
        ...source,
        relations: [
          {
            issueId: "00000000-0000-4000-8000-00000000000a",
            relatedIssueId: "00000000-0000-4000-8000-00000000000a",
            type: "related",
          },
          {
            issueId: "00000000-0000-4000-8000-00000000000a",
            relatedIssueId: "00000000-0000-4000-8000-00000000000b",
            type: "blocks",
          },
          {
            issueId: "00000000-0000-4000-8000-00000000000b",
            relatedIssueId: "00000000-0000-4000-8000-00000000000a",
            type: "blocks",
          },
        ],
      };
      const result = writeLinearExportToRepo(invalid, root, { dryRun: true });
      expect(result.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "SELF_RELATION" }),
          expect.objectContaining({ code: "BLOCKING_RELATION_CYCLE" }),
        ]),
      );
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancela el issue duplicado y registra state_changed durante el rebuild", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-duplicate-"));
    const db = new Database(":memory:", { strict: true });
    try {
      const duplicate: LinearExport = {
        ...source,
        teams: [
          {
            ...source.teams[0]!,
            states: [
              ...source.teams[0]!.states,
              {
                id: "00000000-0000-4000-8000-00000000000d",
                name: "Canceled",
                type: "canceled",
                position: 2,
              },
            ],
          },
        ],
        relations: [
          {
            issueId: "00000000-0000-4000-8000-00000000000a",
            relatedIssueId: "00000000-0000-4000-8000-00000000000b",
            type: "duplicate_of",
          },
        ],
      };
      const result = writeLinearExportToRepo(duplicate, root);
      expect(result.conflicts).toEqual([]);
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db);
      rebuildFromRepo(db, root);
      const state = db
        .query(
          `SELECT workflow_states.type FROM issues
           JOIN workflow_states ON workflow_states.id = issues.state_id
           JOIN teams ON teams.id = issues.team_id
           WHERE teams.key = 'AT' AND issues.number = 1`,
        )
        .get() as { type: string };
      expect(state.type).toBe("canceled");
      expect(db.query("SELECT type FROM issue_relations").get()).toEqual({ type: "duplicate_of" });
      expect(
        db
          .query(
            `SELECT count(*) AS n FROM activity
             JOIN issues ON issues.id = activity.issue_id
             JOIN teams ON teams.id = issues.team_id
             WHERE activity.type = 'state_changed' AND teams.key = 'AT' AND issues.number = 1`,
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(
        db.query("SELECT count(*) AS n FROM activity WHERE type = 'relation_added'").get(),
      ).toEqual({ n: 2 });
      expect(db.query("SELECT payload FROM activity WHERE type = 'relation_added'").all()).toEqual(
        expect.arrayContaining([
          { payload: JSON.stringify({ type: "duplicate_of", issue: "AT-2" }) },
          { payload: JSON.stringify({ type: "duplicated_by", issue: "AT-1" }) },
        ]),
      );
      const teamsPath = join(root, ".prime-board", "meta", "teams.json");
      const teams = JSON.parse(readFileSync(teamsPath, "utf8")) as Array<Record<string, any>>;
      teams[0]!.states = teams[0]!.states.filter(
        (workflowState: Record<string, unknown>) => workflowState.name !== "Canceled",
      );
      writeFileSync(teamsPath, JSON.stringify(teams));
      expect(() => rebuildFromRepo(db, root)).toThrow(/no canceled state/);
      expect(db.query("SELECT count(*) AS n FROM issues").get()).toEqual({ n: 2 });
      const roundtrip = mkdtempSync(join(process.cwd(), "scratchpad-linear-duplicate-roundtrip-"));
      try {
        exportBoard(db, roundtrip);
        expect(
          readFileSync(join(roundtrip, ".prime-board", "log", "AT-1.jsonl"), "utf8"),
        ).toContain('"type":"state_changed"');
      } finally {
        rmSync(roundtrip, { recursive: true, force: true });
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza referencias que existen pero pertenecen a otro Team o Project", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-cross-ref-"));
    try {
      const cross: LinearExport = {
        ...source,
        teams: [
          source.teams[0]!,
          {
            id: "team-2",
            key: "BT",
            name: "Otro",
            states: [{ id: "state-b", name: "Todo", type: "unstarted" }],
          },
        ],
        labels: [...source.labels, { id: "label-b", name: "Feature", teamId: "team-2" }],
        projects: [
          source.projects[0]!,
          {
            id: "project-b",
            name: "Otro proyecto",
            state: "started",
            teamIds: ["team-2"],
            milestones: [{ id: "milestone-b", name: "M1" }],
          },
        ],
        issues: [
          {
            ...source.issues[0]!,
            stateId: "state-b",
            parentId: "issue-b",
            projectId: "project-b",
            milestoneId: "00000000-0000-4000-8000-000000000009",
            labelIds: ["label-b"],
          },
          {
            ...source.issues[1]!,
            id: "issue-b",
            identifier: "BT-1",
            number: 1,
            teamId: "team-2",
            stateId: "state-b",
            stateHistory: [{ stateId: "state-b", startedAt: "2026-01-02T00:00:00.000Z" }],
            parentId: null,
            projectId: null,
            milestoneId: null,
            labelIds: [],
          },
        ],
        relations: [],
      };
      const result = writeLinearExportToRepo(cross, root, { dryRun: true });
      expect(result.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "CROSS_TEAM_ISSUE_STATE" }),
          expect.objectContaining({ code: "CROSS_TEAM_ISSUE_LABEL" }),
          expect.objectContaining({ code: "CROSS_TEAM_ISSUE_PROJECT" }),
          expect.objectContaining({ code: "CROSS_PROJECT_ISSUE_MILESTONE" }),
          expect.objectContaining({ code: "CROSS_TEAM_PARENT" }),
        ]),
      );
      expect(existsSync(join(root, ".prime-board"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normaliza cero en períodos de automatización sin conflicto", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-automation-"));
    try {
      const automation: LinearExport = {
        ...source,
        teams: [{ ...source.teams[0]!, autoClosePeriod: 0, autoArchivePeriod: 0 }],
      };
      const result = writeLinearExportToRepo(automation, root);
      expect(result.conflicts).toEqual([]);
      const teams = JSON.parse(
        readFileSync(join(root, ".prime-board", "meta", "teams.json"), "utf8"),
      ) as Array<Record<string, unknown>>;
      expect(teams[0]).toMatchObject({ autoClosePeriod: null, autoArchivePeriod: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
