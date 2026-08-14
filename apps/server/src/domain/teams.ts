// Dominio de teams: creación (con workflow default), lookup y mapeos.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { seedTeamWorkflow } from "../db/seed.ts";
import { newId, now } from "../db/util.ts";

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
