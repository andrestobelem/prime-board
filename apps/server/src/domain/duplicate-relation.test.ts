// Regresión PRB-383: duplicate_of usa el estado reservado del issue origen.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, type TestApp } from "../test-helpers.ts";
import { createIssue } from "./issues.ts";
import { createRelation } from "./relations.ts";
import {
  createWorkflowState,
  deleteWorkflowState,
  updateTeam,
  updateWorkflowState,
} from "./teams.ts";

let app: TestApp;
let workspaceId: string;
let teamId: string;
let actorId: string;
let startedStateId: string;
let duplicateStateId: string;

beforeAll(() => {
  app = createTestApp();
  workspaceId = (app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string }).id;
  teamId = (app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string }).id;
  actorId = (app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }).id;
  const states = app.db
    .query("SELECT id, type, is_reserved FROM workflow_states WHERE team_id = ?1")
    .all(teamId) as Array<{ id: string; type: string; is_reserved: number }>;
  startedStateId = states.find((state) => state.type === "started")!.id;
  duplicateStateId = states.find((state) => state.is_reserved === 1)!.id;
});

afterAll(() => app.stop());

describe("duplicate relation", () => {
  it("marks only the duplicate source with the reserved Duplicate state", () => {
    const source = createIssue(app.db, actorId, {
      teamId,
      title: "Duplicate source",
      stateId: startedStateId,
      creatorId: actorId,
      workspaceId,
    });
    const canonical = createIssue(app.db, actorId, {
      teamId,
      title: "Canonical issue",
      stateId: startedStateId,
      creatorId: actorId,
      workspaceId,
    });

    const created = createRelation(
      app.db,
      actorId,
      { issueId: source.id, relatedIssueId: canonical.id, type: "duplicate_of" },
      workspaceId,
    );

    expect(created.issue.id).toBe(source.id);
    expect(created.issue.state_id).toBe(duplicateStateId);
    expect(created.relatedIssue.state_id).toBe(startedStateId);
    expect(created.stateChange).toEqual({
      issueId: source.id,
      from: startedStateId,
      to: duplicateStateId,
    });
    expect(
      app.db
        .query("SELECT type FROM activity WHERE issue_id = ?1 ORDER BY created_at, id")
        .all(source.id)
        .map((row) => (row as { type: string }).type),
    ).toContain("state_changed");
  });
  it("rejects customization, deletion, and default assignment for Duplicate", () => {
    expect(() => updateWorkflowState(app.db, duplicateStateId, { name: "Closed" })).toThrow(
      "managed by the system",
    );
    expect(() => deleteWorkflowState(app.db, actorId, duplicateStateId)).toThrow(
      "cannot be deleted",
    );
    expect(() => updateTeam(app.db, teamId, { defaultStateId: duplicateStateId })).toThrow(
      "cannot be the default",
    );
    expect(() =>
      createWorkflowState(app.db, { teamId, name: "duplicate", type: "canceled" }),
    ).toThrow("reserved workflow state name");
  });
});
