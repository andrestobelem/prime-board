// Dominio de teams: creación (con workflow default), lookup y mapeos.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { seedTeamWorkflow } from "../db/seed.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";

export interface TeamRow {
  id: string;
  name: string;
  key: string;
  description: string | null;
  next_issue_number: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStateRow {
  id: string;
  team_id: string;
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
  color: string;
  position: number;
}

export function mapTeam(row: TeamRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    _row: row,
  };
}

export function mapWorkflowState(row: WorkflowStateRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    color: row.color,
    position: row.position,
  };
}

export function getTeam(db: Database, ref: { id?: string | null; key?: string | null }): TeamRow | null {
  if (ref.id) {
    return db.query("SELECT * FROM teams WHERE id = ?1").get(ref.id) as TeamRow | null;
  }
  if (ref.key) {
    return db.query("SELECT * FROM teams WHERE key = ?1").get(ref.key.toUpperCase()) as TeamRow | null;
  }
  return null;
}

export function listTeamStates(db: Database, teamId: string): WorkflowStateRow[] {
  return db
    .query("SELECT * FROM workflow_states WHERE team_id = ?1 ORDER BY position")
    .all(teamId) as WorkflowStateRow[];
}

export function createTeam(
  db: Database,
  input: { name: string; key: string; description?: string | null },
): TeamRow {
  const name = input.name.trim();
  const key = input.key.trim().toUpperCase();
  if (!name) throw apiError("VALIDATION_FAILED", "Team name cannot be empty");
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(key)) {
    throw apiError("VALIDATION_FAILED", "Team key must be 1-8 alphanumeric characters starting with a letter");
  }
  const duplicate = db.query("SELECT id FROM teams WHERE key = ?1").get(key);
  if (duplicate) throw apiError("VALIDATION_FAILED", `Team key ${key} is already in use`);

  const id = newId();
  db.transaction(() => {
    const timestamp = now();
    db.query(
      "INSERT INTO teams (id, name, key, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).run(id, name, key, input.description ?? null, timestamp, timestamp);
    seedTeamWorkflow(db, id);
  })();
  return db.query("SELECT * FROM teams WHERE id = ?1").get(id) as TeamRow;
}

const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

/**
 * Borra un estado migrando sus issues a otro (AT-164). `issues.state_id` es NOT
 * NULL: sin destino no hay borrado posible. Se protegen dos invariantes: el team
 * no puede quedarse sin estados, ni sin un estado `completed` (el board necesita
 * uno para cerrar trabajo y el progreso de milestones se calcula con él).
 */
export function deleteWorkflowState(
  db: Database,
  actorId: string,
  id: string,
  moveToStateId?: string | null,
): number {
  const state = db.query("SELECT * FROM workflow_states WHERE id = ?1").get(id) as WorkflowStateRow | null;
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");

  const siblings = db
    .query("SELECT * FROM workflow_states WHERE team_id = ?1 AND id != ?2")
    .all(state.team_id, id) as WorkflowStateRow[];
  if (siblings.length === 0) {
    throw apiError("VALIDATION_FAILED", "A team must keep at least one workflow state");
  }
  if (state.type === "completed" && !siblings.some((candidate) => candidate.type === "completed")) {
    throw apiError("VALIDATION_FAILED", "A team must keep at least one completed state");
  }

  const affected = db
    .query("SELECT count(*) AS n FROM issues WHERE state_id = ?1")
    .get(id) as { n: number };

  let target: WorkflowStateRow | null = null;
  if (affected.n > 0) {
    if (!moveToStateId) {
      throw apiError(
        "VALIDATION_FAILED",
        `State has ${affected.n} issue(s): provide moveToStateId to migrate them`,
      );
    }
    target = siblings.find((candidate) => candidate.id === moveToStateId) ?? null;
    if (!target) {
      throw apiError("VALIDATION_FAILED", "moveToStateId must be another state of the same team");
    }
  }

  db.transaction(() => {
    if (target) {
      const issues = db.query("SELECT id FROM issues WHERE state_id = ?1").values(id).map((row) => row[0] as string);
      db.query("UPDATE issues SET state_id = ?1, updated_at = ?2 WHERE state_id = ?3")
        .run(target.id, now(), id);
      // Cada migración queda en el historial, como cualquier cambio de estado.
      for (const issueId of issues) {
        recordActivity(db, issueId, actorId, "state_changed", { from: id, to: target.id, reason: "state_deleted" });
      }
    }
    db.query("DELETE FROM workflow_states WHERE id = ?1").run(id);
  })();

  return affected.n;
}

export function updateWorkflowState(
  db: Database,
  id: string,
  input: { name?: string | null; type?: string | null; color?: string | null; position?: number | null },
): WorkflowStateRow {
  const state = db.query("SELECT * FROM workflow_states WHERE id = ?1").get(id) as WorkflowStateRow | null;
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");
  if (input.type != null && !STATE_TYPES.includes(input.type)) {
    throw apiError("VALIDATION_FAILED", `Invalid state type: ${input.type}`);
  }
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "State name cannot be empty");
    const duplicate = db
      .query("SELECT id FROM workflow_states WHERE team_id = ?1 AND name = ?2 AND id != ?3")
      .get(state.team_id, name, id);
    if (duplicate) throw apiError("VALIDATION_FAILED", "State name already exists in this team");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };
  if (input.name != null) push("name", input.name.trim());
  if (input.type != null) push("type", input.type);
  if (input.color != null) push("color", input.color);
  if (input.position != null) push("position", input.position);
  if (sets.length > 0) {
    push("updated_at", now());
    params.push(id);
    db.query(`UPDATE workflow_states SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(...(params as never[]));
  }
  return db.query("SELECT * FROM workflow_states WHERE id = ?1").get(id) as WorkflowStateRow;
}

export function createWorkflowState(
  db: Database,
  input: { teamId: string; name: string; type: string; color?: string | null; position?: number | null },
): WorkflowStateRow {
  const team = getTeam(db, { id: input.teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (!input.name.trim()) throw apiError("VALIDATION_FAILED", "State name cannot be empty");
  if (!STATE_TYPES.includes(input.type)) {
    throw apiError("VALIDATION_FAILED", `Invalid state type: ${input.type}`);
  }
  const duplicate = db
    .query("SELECT id FROM workflow_states WHERE team_id = ?1 AND name = ?2")
    .get(team.id, input.name.trim());
  if (duplicate) throw apiError("VALIDATION_FAILED", "State name already exists in this team");

  const maxPosition = db
    .query("SELECT coalesce(max(position), -1) AS max FROM workflow_states WHERE team_id = ?1")
    .get(team.id) as { max: number };
  const id = newId();
  const timestamp = now();
  db.query(
    "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  ).run(
    id, team.id, input.name.trim(), input.type,
    input.color ?? "#95a2b3", input.position ?? maxPosition.max + 1,
    timestamp, timestamp,
  );
  return db.query("SELECT * FROM workflow_states WHERE id = ?1").get(id) as WorkflowStateRow;
}
