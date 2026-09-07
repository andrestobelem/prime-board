// Contrato de elegibilidad para el worker futuro de automatizaciones.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createCycle } from "./cycles.ts";
import { createIssue } from "./issues.ts";
import { createProject } from "./projects.ts";
import {
  evaluateAutoArchive,
  evaluateAutoClose,
  listAutomationCandidates,
} from "./workflow-automations.ts";
import { createTestApp, type TestApp } from "../test-helpers.ts";
import { updateTeam } from "./teams.ts";

let app: TestApp;
let workspaceId: string;
let teamId: string;
let actorId: string;
let startedStateId: string;
let completedStateId: string;
let canceledStateId: string;
const NOW = Date.parse("2026-09-10T00:00:00.000Z");
const OLD = "2026-09-01T00:00:00.000Z";

beforeAll(() => {
  app = createTestApp();
  workspaceId = (app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string }).id;
  teamId = (app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string }).id;
  actorId = (app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }).id;
  const states = app.db
    .query("SELECT id, type FROM workflow_states WHERE team_id = ?1")
    .all(teamId) as Array<{ id: string; type: string }>;
  startedStateId = states.find((state) => state.type === "started")!.id;
  completedStateId = states.find((state) => state.type === "completed")!.id;
  canceledStateId = states.find((state) => state.type === "canceled")!.id;
  updateTeam(
    app.db,
    teamId,
    {
      autoClosePeriod: 1,
      autoArchivePeriod: 1,
      autoCloseStateId: completedStateId,
      autoCloseParentIssues: true,
      autoCloseChildIssues: true,
    },
    workspaceId,
  );
});

afterAll(() => app.stop());

function issue(title: string, stateId = startedStateId, parentId?: string, projectId?: string) {
  return createIssue(app.db, actorId, {
    teamId,
    title,
    stateId,
    parentId,
    projectId,
    creatorId: actorId,
    workspaceId,
  });
}

function setUpdatedAt(id: string, value = OLD): void {
  app.db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2").run(value, id);
}

function setState(id: string, stateId: string): void {
  app.db
    .query("UPDATE issues SET state_id = ?1, updated_at = ?2 WHERE id = ?3")
    .run(stateId, OLD, id);
}

describe("workflow automation eligibility", () => {
  it("returns a completed target without mutating the issue", () => {
    const candidate = issue("Eligible for close");
    setUpdatedAt(candidate.id);

    const decision = evaluateAutoClose(app.db, candidate.id, NOW, workspaceId);

    expect(decision).toEqual({
      eligible: true,
      reason: "eligible",
      targetStateId: completedStateId,
    });
    expect(
      app.db.query("SELECT state_id, archived_at FROM issues WHERE id = ?1").get(candidate.id) as {
        state_id: string;
        archived_at: string | null;
      },
    ).toEqual({ state_id: startedStateId, archived_at: null });
  });

  it("blocks active cycles, unfinished projects, and recursive pending children", () => {
    const parent = issue("Parent with children");
    const child = issue("Open child", startedStateId, parent.id);
    const grandchild = issue("Open grandchild", startedStateId, child.id);
    setUpdatedAt(parent.id);
    setUpdatedAt(child.id);
    setUpdatedAt(grandchild.id);
    expect(evaluateAutoClose(app.db, parent.id, NOW, workspaceId).reason).toBe("pending_sub_issue");

    setState(grandchild.id, completedStateId);
    setState(child.id, completedStateId);
    expect(evaluateAutoClose(app.db, parent.id, NOW, workspaceId).eligible).toBe(true);

    const project = createProject(
      app.db,
      { name: "Unfinished project", state: "started", teamIds: [teamId] },
      workspaceId,
    );
    const projectIssue = issue(
      "Issue in unfinished project",
      startedStateId,
      undefined,
      project.id,
    );
    setUpdatedAt(projectIssue.id);
    expect(evaluateAutoClose(app.db, projectIssue.id, NOW, workspaceId).reason).toBe(
      "unfinished_project",
    );
    app.db.query("UPDATE projects SET state = 'completed' WHERE id = ?1").run(project.id);

    const cycle = createCycle(
      app.db,
      {
        teamId,
        name: "Active cycle",
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-15T00:00:00.000Z",
        state: "active",
      },
      workspaceId,
    );
    app.db.query("UPDATE issues SET cycle_id = ?1 WHERE id = ?2").run(cycle.id, projectIssue.id);
    expect(evaluateAutoClose(app.db, projectIssue.id, NOW, workspaceId).reason).toBe(
      "active_cycle",
    );
  });

  it("honors parent and child participation flags", () => {
    const parent = issue("Disabled parent");
    const child = issue("Disabled child", startedStateId, parent.id);
    setUpdatedAt(parent.id);
    setUpdatedAt(child.id);
    updateTeam(app.db, teamId, { autoCloseParentIssues: false }, workspaceId);
    expect(evaluateAutoClose(app.db, parent.id, NOW, workspaceId).reason).toBe(
      "parent_issues_disabled",
    );
    updateTeam(
      app.db,
      teamId,
      { autoCloseParentIssues: true, autoCloseChildIssues: false },
      workspaceId,
    );
    expect(evaluateAutoClose(app.db, child.id, NOW, workspaceId).reason).toBe(
      "child_issues_disabled",
    );
    updateTeam(app.db, teamId, { autoCloseChildIssues: true }, workspaceId);
  });

  it("requires a closed, inactive issue and closed descendants for auto-archive", () => {
    const open = issue("Still open");
    setUpdatedAt(open.id);
    expect(evaluateAutoArchive(app.db, open.id, NOW, workspaceId).reason).toBe("already_closed");

    const closed = issue("Closed and inactive", completedStateId);
    setUpdatedAt(closed.id);
    expect(evaluateAutoArchive(app.db, closed.id, NOW, workspaceId)).toEqual({
      eligible: true,
      reason: "eligible",
    });

    const archivedChild = issue("Archived child", completedStateId, closed.id);
    app.db.query("UPDATE issues SET archived_at = ?1 WHERE id = ?2").run(OLD, archivedChild.id);
    expect(evaluateAutoArchive(app.db, closed.id, NOW, workspaceId).reason).toBe(
      "pending_sub_issue",
    );

    const candidates = listAutomationCandidates(app.db, teamId, NOW, workspaceId);
    expect(candidates.close.some(({ issue: row }) => row.id === closed.id)).toBe(false);
    expect(candidates.archive.some(({ issue: row }) => row.id === closed.id)).toBe(false);
  });

  it("skips archived issues and archived teams", () => {
    const archived = issue("Archived issue");
    setUpdatedAt(archived.id);
    app.db.query("UPDATE issues SET archived_at = ?1 WHERE id = ?2").run(OLD, archived.id);
    expect(evaluateAutoClose(app.db, archived.id, NOW, workspaceId).reason).toBe("archived");
    app.db.query("UPDATE issues SET archived_at = NULL WHERE id = ?1").run(archived.id);
    app.db.query("UPDATE teams SET archived_at = ?1 WHERE id = ?2").run(OLD, teamId);
    expect(evaluateAutoClose(app.db, archived.id, NOW, workspaceId).reason).toBe("archived");
    app.db.query("UPDATE teams SET archived_at = NULL WHERE id = ?1").run(teamId);
  });

  it("rejects a missing explicit completed target", () => {
    const candidate = issue("Missing close target");
    setUpdatedAt(candidate.id);
    app.db
      .query("UPDATE teams SET auto_close_state_id = ?1 WHERE id = ?2")
      .run(canceledStateId, teamId);
    // GraphQL/domain validation normally rejects this; malformed imported data remains ineligible.
    expect(evaluateAutoClose(app.db, candidate.id, NOW, workspaceId).reason).toBe(
      "missing_completed_state",
    );
    updateTeam(app.db, teamId, { autoCloseStateId: completedStateId }, workspaceId);
  });
});
