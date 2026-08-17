// Iniciativas de workspace (PRB-206).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getProject } from "./projects.ts";
import { parseDateTime } from "./datetime.ts";
import { assertTeamMember, isTeamMember } from "./team-memberships.ts";

export type InitiativeState = "planned" | "active" | "completed" | "canceled";

export interface InitiativeRow {
  id: string;
  name: string;
  description: string | null;
  state: InitiativeState;
  target_date: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function mapInitiative(row: InitiativeRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    targetDate: row.target_date,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function getInitiative(db: Database, id: string): InitiativeRow | null {
  return db.query("SELECT * FROM initiatives WHERE id = ?1").get(id) as InitiativeRow | null;
}

export function listInitiatives(
  db: Database,
  includeArchived = false,
  viewerId?: string,
): InitiativeRow[] {
  const rows = (
    includeArchived
      ? db.query("SELECT * FROM initiatives ORDER BY created_at").all()
      : db.query("SELECT * FROM initiatives WHERE archived_at IS NULL ORDER BY created_at").all()
  ) as InitiativeRow[];
  return viewerId ? rows.filter((row) => canViewInitiative(db, row.id, viewerId)) : rows;
}

export function listInitiativeTeamIds(db: Database, initiativeId: string): string[] {
  return db
    .query("SELECT team_id FROM initiative_teams WHERE initiative_id = ?1 ORDER BY team_id")
    .values(initiativeId)
    .map((row) => row[0] as string);
}

export function listInitiativeProjectIds(db: Database, initiativeId: string): string[] {
  return db
    .query("SELECT project_id FROM initiative_projects WHERE initiative_id = ?1")
    .values(initiativeId)
    .map((row) => row[0] as string);
}

function resolveState(state: string): InitiativeState {
  const normalized = state.toLowerCase() as InitiativeState;
  if (
    normalized !== "planned" &&
    normalized !== "active" &&
    normalized !== "completed" &&
    normalized !== "canceled"
  ) {
    throw apiError("VALIDATION_FAILED", `Invalid initiative state: ${state}`);
  }
  return normalized;
}

function setTeams(db: Database, initiativeId: string, teamIds: string[], viewerId: string): void {
  for (const teamId of new Set(teamIds)) {
    assertTeamMember(db, teamId, viewerId);
  }
  db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1").run(initiativeId);
  const insert = db.query("INSERT INTO initiative_teams (initiative_id, team_id) VALUES (?1, ?2)");
  for (const teamId of new Set(teamIds)) insert.run(initiativeId, teamId);
}

export function canViewInitiative(db: Database, initiativeId: string, viewerId: string): boolean {
  const teamIds = listInitiativeTeamIds(db, initiativeId);
  return teamIds.length === 0 || teamIds.some((teamId) => isTeamMember(db, teamId, viewerId));
}

function assertCanAccess(db: Database, existing: InitiativeRow, viewerId: string): void {
  if (!canViewInitiative(db, existing.id, viewerId)) {
    throw apiError("NOT_FOUND", "Initiative not found");
  }
}

function setProjects(db: Database, initiativeId: string, projectIds: string[]): void {
  for (const projectId of projectIds) {
    if (!getProject(db, projectId)) throw apiError("NOT_FOUND", `Project not found: ${projectId}`);
  }
  db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1").run(initiativeId);
  const insert = db.query(
    "INSERT INTO initiative_projects (initiative_id, project_id) VALUES (?1, ?2)",
  );
  for (const projectId of projectIds) {
    insert.run(initiativeId, projectId);
  }
}

export function createInitiative(
  db: Database,
  ownerId: string,
  input: {
    name: string;
    description?: string | null;
    state?: string | null;
    targetDate?: string | null;
    projectIds?: string[] | null;
    teamIds?: string[] | null;
  },
): InitiativeRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Initiative name cannot be empty");
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  const id = newId();
  const timestamp = now();
  const state = input.state ? resolveState(input.state) : "planned";
  db.transaction(() => {
    db.query(
      `INSERT INTO initiatives
        (id, name, description, state, target_date, owner_id, created_at, updated_at, archived_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL)`,
    ).run(id, name, input.description ?? null, state, input.targetDate ?? null, ownerId, timestamp);
    if (input.projectIds?.length) setProjects(db, id, input.projectIds);
    if (input.teamIds !== undefined && input.teamIds !== null)
      setTeams(db, id, input.teamIds, ownerId);
  })();
  return getInitiative(db, id)!;
}

function assertCanMutate(db: Database, existing: InitiativeRow, viewerId: string): void {
  assertCanAccess(db, existing, viewerId);
  // Sin dueño (datos migrados): cualquier viewer autenticado puede mutar.
  if (existing.owner_id && existing.owner_id !== viewerId) {
    throw apiError("NOT_FOUND", "Initiative not found");
  }
}

export function updateInitiative(
  db: Database,
  id: string,
  viewerId: string,
  input: {
    name?: string | null;
    description?: string | null;
    state?: string | null;
    targetDate?: string | null;
    projectIds?: string[] | null;
    teamIds?: string[] | null;
    archived?: boolean | null;
  },
): InitiativeRow {
  const existing = getInitiative(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Initiative not found");
  assertCanMutate(db, existing, viewerId);
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };

  db.transaction(() => {
    if (input.name !== undefined && input.name !== null) {
      const name = input.name.trim();
      if (!name) throw apiError("VALIDATION_FAILED", "Initiative name cannot be empty");
      push("name", name);
    }
    if (input.description !== undefined) push("description", input.description);
    if (input.state != null) push("state", resolveState(input.state));
    if (input.targetDate !== undefined) push("target_date", input.targetDate);
    if (input.archived === true) push("archived_at", now());
    if (input.archived === false) push("archived_at", null);

    if (sets.length > 0) {
      push("updated_at", now());
      params.push(id);
      db.query(`UPDATE initiatives SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
        ...(params as never[]),
      );
    }
    if (input.projectIds !== undefined && input.projectIds !== null) {
      setProjects(db, id, input.projectIds);
      if (sets.length === 0) {
        db.query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2").run(now(), id);
      }
    }
    if (input.teamIds !== undefined && input.teamIds !== null) {
      setTeams(db, id, input.teamIds, viewerId);
      if (sets.length === 0 && input.projectIds === undefined) {
        db.query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2").run(now(), id);
      }
    }
  })();

  return getInitiative(db, id)!;
}

export function deleteInitiative(db: Database, id: string, viewerId: string): boolean {
  const existing = getInitiative(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Initiative not found");
  assertCanMutate(db, existing, viewerId);
  db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1").run(id);
  db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1").run(id);
  db.query("DELETE FROM initiatives WHERE id = ?1").run(id);
  return true;
}

export function initiativeProgress(
  db: Database,
  initiativeId: string,
): { totalIssues: number; completedIssues: number; progress: number } {
  const row = db
    .query(
      `SELECT count(*) AS total,
              sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
       FROM issues
       JOIN workflow_states ON workflow_states.id = issues.state_id
       WHERE issues.archived_at IS NULL
         AND issues.project_id IN (
           SELECT project_id FROM initiative_projects WHERE initiative_id = ?1
         )`,
    )
    .get(initiativeId) as { total: number; done: number | null };
  const totalIssues = row.total;
  const completedIssues = row.done ?? 0;
  return {
    totalIssues,
    completedIssues,
    progress: totalIssues === 0 ? 0 : completedIssues / totalIssues,
  };
}
