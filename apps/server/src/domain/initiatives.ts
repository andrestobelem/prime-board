// Iniciativas de workspace (PRB-206).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getProject, listProjectTeamIds } from "./projects.ts";
import { getTeam } from "./teams.ts";
import { parseDateTime } from "./datetime.ts";
import { isTeamMember } from "./team-memberships.ts";
import type { ActorRow } from "../auth/viewer.ts";
import {
  assertCanManageIssue,
  assertCanManageProject,
  canAccessProject,
} from "../auth/permissions.ts";

export type InitiativeState = "planned" | "active" | "completed" | "canceled";

export interface InitiativeRow {
  id: string;
  name: string;
  description: string | null;
  state: InitiativeState;
  priority: number;
  target_date: string | null;
  lead_team_id: string | null;
  resources_json: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  workspace_id: string | null;
}

type ViewerRef = string | ActorRow;

function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

function resolveViewer(db: Database, viewer: ViewerRef): ActorRow | null {
  if (typeof viewer !== "string") return viewer;
  return db.query("SELECT * FROM actors WHERE id = ?1").get(viewer) as ActorRow | null;
}

function viewerId(viewer: ViewerRef): string {
  return typeof viewer === "string" ? viewer : viewer.id;
}

function parseResources(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function mapInitiative(row: InitiativeRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    priority: row.priority,
    targetDate: row.target_date,
    leadTeamId: row.lead_team_id,
    resources: parseResources(row.resources_json),
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function getInitiative(
  db: Database,
  id: string,
  workspaceId?: string,
): InitiativeRow | null {
  const query = workspaceId
    ? "SELECT * FROM initiatives WHERE id = ?1 AND workspace_id = ?2"
    : "SELECT * FROM initiatives WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as InitiativeRow | null;
}

export function listInitiatives(
  db: Database,
  includeArchived = false,
  viewer?: ViewerRef,
  workspaceId?: string,
): InitiativeRow[] {
  const conditions = includeArchived ? [] : ["archived_at IS NULL"];
  if (workspaceId) conditions.push("workspace_id = ?1");
  const query = `SELECT * FROM initiatives${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at`;
  const rows = (
    workspaceId ? db.query(query).all(workspaceId) : db.query(query).all()
  ) as InitiativeRow[];
  return viewer ? rows.filter((row) => canViewInitiative(db, row.id, viewer, workspaceId)) : rows;
}

export function listInitiativeTeamIds(
  db: Database,
  initiativeId: string,
  workspaceId?: string,
): string[] {
  const query = workspaceId
    ? "SELECT team_id FROM initiative_teams WHERE initiative_id = ?1 AND workspace_id = ?2 ORDER BY team_id"
    : "SELECT team_id FROM initiative_teams WHERE initiative_id = ?1 ORDER BY team_id";
  return (
    workspaceId
      ? db.query(query).values(initiativeId, workspaceId)
      : db.query(query).values(initiativeId)
  ).map((row) => row[0] as string);
}

export function listInitiativeProjectIds(
  db: Database,
  initiativeId: string,
  workspaceId?: string,
): string[] {
  const query = workspaceId
    ? "SELECT project_id FROM initiative_projects WHERE initiative_id = ?1 AND workspace_id = ?2"
    : "SELECT project_id FROM initiative_projects WHERE initiative_id = ?1";
  return (
    workspaceId
      ? db.query(query).values(initiativeId, workspaceId)
      : db.query(query).values(initiativeId)
  ).map((row) => row[0] as string);
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

function setTeams(
  db: Database,
  initiativeId: string,
  teamIds: string[],
  viewerRef: ViewerRef,
  workspaceId?: string,
): void {
  const viewer = resolveViewer(db, viewerRef);
  if (!viewer) throw apiError("NOT_FOUND", "Actor not found");
  for (const teamId of new Set(teamIds)) {
    if (!getTeam(db, { id: teamId }, workspaceId)) {
      throw apiError("NOT_FOUND", `Team not found: ${teamId}`);
    }
    assertCanManageIssue(db, viewer, teamId);
  }
  if (workspaceId) {
    db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1 AND workspace_id = ?2").run(
      initiativeId,
      workspaceId,
    );
  } else {
    db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1").run(initiativeId);
  }
  const insert = db.query(
    "INSERT INTO initiative_teams (initiative_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
  );
  for (const teamId of new Set(teamIds)) insert.run(initiativeId, teamId, workspaceId ?? null);
}

export function canViewInitiative(
  db: Database,
  initiativeId: string,
  viewerRef: ViewerRef,
  workspaceId?: string,
): boolean {
  const viewer = resolveViewer(db, viewerRef);
  if (!viewer) return false;
  const teamIds = new Set(listInitiativeTeamIds(db, initiativeId, workspaceId));
  for (const projectId of listInitiativeProjectIds(db, initiativeId, workspaceId)) {
    for (const teamId of listProjectTeamIds(db, projectId, workspaceId)) teamIds.add(teamId);
    if (!canAccessProject(db, viewer, projectId)) return false;
  }
  return [...teamIds].every(
    (teamId) => viewer.workspace_role === "admin" || isTeamMember(db, teamId, viewer.id),
  );
}

function assertCanAccess(
  db: Database,
  existing: InitiativeRow,
  viewerRef: ViewerRef,
  workspaceId?: string,
): void {
  if (!canViewInitiative(db, existing.id, viewerRef, workspaceId)) {
    throw apiError("NOT_FOUND", "Initiative not found");
  }
}

function setProjects(
  db: Database,
  initiativeId: string,
  projectIds: string[],
  viewerRef: ViewerRef,
  workspaceId?: string,
): void {
  const viewer = resolveViewer(db, viewerRef);
  if (!viewer) throw apiError("NOT_FOUND", "Actor not found");
  for (const projectId of projectIds) {
    if (!getProject(db, projectId, workspaceId)) {
      throw apiError("NOT_FOUND", `Project not found: ${projectId}`);
    }
    assertCanManageProject(db, viewer, projectId);
  }
  if (workspaceId) {
    db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1 AND workspace_id = ?2").run(
      initiativeId,
      workspaceId,
    );
  } else {
    db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1").run(initiativeId);
  }
  const insert = db.query(
    "INSERT INTO initiative_projects (initiative_id, project_id, workspace_id) VALUES (?1, ?2, ?3)",
  );
  for (const projectId of projectIds) {
    insert.run(initiativeId, projectId, workspaceId ?? null);
  }
}

export function createInitiative(
  db: Database,
  ownerRef: ViewerRef,
  input: {
    name: string;
    description?: string | null;
    state?: string | null;
    priority?: number | null;
    targetDate?: string | null;
    leadTeamId?: string | null;
    labelIds?: string[] | null;
    resources?: unknown[] | null;
    projectIds?: string[] | null;
    teamIds?: string[] | null;
  },
  workspaceId?: string,
): InitiativeRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Initiative name cannot be empty");
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  validatePriority(input.priority);
  if (input.leadTeamId != null && !getTeam(db, { id: input.leadTeamId }, workspaceId)) {
    throw apiError("NOT_FOUND", "Initiative lead team not found");
  }
  validateResources(input.resources);
  validateLabels(db, input.labelIds, workspaceId);
  const ownerId = viewerId(ownerRef);
  const id = newId();
  const timestamp = now();
  const state = input.state ? resolveState(input.state) : "planned";
  db.transaction(() => {
    db.query(
      `INSERT INTO initiatives
        (id, name, description, state, priority, target_date, lead_team_id, resources_json, owner_id, created_at, updated_at, archived_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL, ?11)`,
    ).run(
      id,
      name,
      input.description ?? null,
      state,
      input.priority ?? 0,
      input.targetDate ?? null,
      input.leadTeamId ?? null,
      JSON.stringify(input.resources ?? []),
      ownerId,
      timestamp,
      workspaceId ?? null,
    );
    if (input.projectIds?.length) setProjects(db, id, input.projectIds, ownerRef, workspaceId);
    if (input.teamIds !== undefined && input.teamIds !== null)
      setTeams(db, id, input.teamIds, ownerRef, workspaceId);
    if (input.labelIds !== undefined && input.labelIds !== null)
      setLabels(db, id, input.labelIds, workspaceId);
  })();
  return getInitiative(db, id, workspaceId)!;
}

function assertCanMutate(
  db: Database,
  existing: InitiativeRow,
  viewerRef: ViewerRef,
  workspaceId?: string,
): void {
  assertCanAccess(db, existing, viewerRef, workspaceId);
  // Sin dueño (datos migrados): cualquier viewer autenticado puede mutar.
  if (existing.owner_id && existing.owner_id !== viewerId(viewerRef)) {
    throw apiError("NOT_FOUND", "Initiative not found");
  }
}

export function updateInitiative(
  db: Database,
  id: string,
  viewerRef: ViewerRef,
  input: {
    name?: string | null;
    description?: string | null;
    state?: string | null;
    priority?: number | null;
    targetDate?: string | null;
    leadTeamId?: string | null;
    labelIds?: string[] | null;
    resources?: unknown[] | null;
    projectIds?: string[] | null;
    teamIds?: string[] | null;
    archived?: boolean | null;
  },
  workspaceId?: string,
): InitiativeRow {
  const existing = getInitiative(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Initiative not found");
  assertCanMutate(db, existing, viewerRef, workspaceId);
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  validatePriority(input.priority);
  if (
    input.leadTeamId !== undefined &&
    input.leadTeamId !== null &&
    !getTeam(db, { id: input.leadTeamId }, workspaceId)
  ) {
    throw apiError("NOT_FOUND", "Initiative lead team not found");
  }
  validateResources(input.resources);
  validateLabels(db, input.labelIds, workspaceId);

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
    if (input.priority !== undefined && input.priority !== null) push("priority", input.priority);
    if (input.targetDate !== undefined) push("target_date", input.targetDate);
    if (input.leadTeamId !== undefined) push("lead_team_id", input.leadTeamId);
    if (input.resources !== undefined)
      push("resources_json", JSON.stringify(input.resources ?? []));
    if (input.archived === true) push("archived_at", now());
    if (input.archived === false) push("archived_at", null);

    if (sets.length > 0) {
      push("updated_at", now());
      params.push(id);
      if (workspaceId) {
        params.push(workspaceId);
        db.query(
          `UPDATE initiatives SET ${sets.join(", ")} WHERE id = ?${params.length - 1} AND workspace_id = ?${params.length}`,
        ).run(...(params as never[]));
      } else {
        db.query(`UPDATE initiatives SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
          ...(params as never[]),
        );
      }
    }
    if (input.projectIds !== undefined && input.projectIds !== null) {
      setProjects(db, id, input.projectIds, viewerRef, workspaceId);
      if (sets.length === 0) {
        workspaceId
          ? db
              .query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3")
              .run(now(), id, workspaceId)
          : db.query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2").run(now(), id);
      }
    }
    if (input.teamIds !== undefined && input.teamIds !== null) {
      setTeams(db, id, input.teamIds, viewerRef, workspaceId);
      if (sets.length === 0 && input.projectIds === undefined && input.labelIds === undefined) {
        workspaceId
          ? db
              .query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3")
              .run(now(), id, workspaceId)
          : db.query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2").run(now(), id);
      }
    }
    if (input.labelIds !== undefined && input.labelIds !== null) {
      setLabels(db, id, input.labelIds, workspaceId);
      if (sets.length === 0 && input.projectIds === undefined && input.teamIds === undefined) {
        workspaceId
          ? db
              .query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3")
              .run(now(), id, workspaceId)
          : db.query("UPDATE initiatives SET updated_at = ?1 WHERE id = ?2").run(now(), id);
      }
    }
  })();

  return getInitiative(db, id, workspaceId)!;
}

export function deleteInitiative(
  db: Database,
  id: string,
  viewerRef: ViewerRef,
  workspaceId?: string,
): boolean {
  const existing = getInitiative(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Initiative not found");
  assertCanMutate(db, existing, viewerRef, workspaceId);
  if (workspaceId) {
    db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1 AND workspace_id = ?2").run(
      id,
      workspaceId,
    );
    db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1 AND workspace_id = ?2").run(
      id,
      workspaceId,
    );
    db.query("DELETE FROM initiatives WHERE id = ?1 AND workspace_id = ?2").run(id, workspaceId);
  } else {
    db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1").run(id);
    db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1").run(id);
    db.query("DELETE FROM initiatives WHERE id = ?1").run(id);
  }
  return true;
}

function validatePriority(priority: number | null | undefined): void {
  if (
    priority !== undefined &&
    priority !== null &&
    (!Number.isInteger(priority) || priority < 0 || priority > 4)
  ) {
    throw apiError("VALIDATION_FAILED", "Initiative priority must be an integer between 0 and 4");
  }
}

function validateResources(resources: unknown[] | null | undefined): void {
  if (resources === undefined || resources === null) return;
  if (!Array.isArray(resources))
    throw apiError("VALIDATION_FAILED", "Initiative resources must be a list");
}

function validateLabels(
  db: Database,
  labelIds: string[] | null | undefined,
  workspaceId?: string,
): void {
  if (labelIds === undefined || labelIds === null) return;
  for (const labelId of new Set(labelIds)) {
    const label = workspaceId
      ? db
          .query(`SELECT id FROM labels WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`)
          .get(labelId, workspaceId)
      : db.query("SELECT id FROM labels WHERE id = ?1").get(labelId);
    if (!label) throw apiError("NOT_FOUND", `Initiative label not found: ${labelId}`);
  }
}

function setLabels(
  db: Database,
  initiativeId: string,
  labelIds: string[],
  workspaceId?: string,
): void {
  if (workspaceId)
    db.query(
      `DELETE FROM initiative_labels WHERE initiative_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
    ).run(initiativeId, workspaceId);
  else db.query("DELETE FROM initiative_labels WHERE initiative_id = ?1").run(initiativeId);
  for (const labelId of new Set(labelIds))
    db.query(
      "INSERT INTO initiative_labels (initiative_id, label_id, workspace_id) VALUES (?1, ?2, ?3)",
    ).run(initiativeId, labelId, workspaceId ?? null);
}

export function listInitiativeLabelIds(
  db: Database,
  initiativeId: string,
  workspaceId?: string,
): string[] {
  const query = workspaceId
    ? `SELECT label_id FROM initiative_labels WHERE initiative_id = ?1 AND ${workspaceClause("workspace_id", "?2")} ORDER BY label_id`
    : "SELECT label_id FROM initiative_labels WHERE initiative_id = ?1 ORDER BY label_id";
  return (
    workspaceId
      ? db.query(query).values(initiativeId, workspaceId)
      : db.query(query).values(initiativeId)
  ).map((row) => row[0] as string);
}

export function listInitiativeUpdateRows(
  db: Database,
  initiativeId: string,
  workspaceId?: string,
): Array<Record<string, unknown>> {
  const query = workspaceId
    ? `SELECT * FROM initiative_updates WHERE initiative_id = ?1 AND ${workspaceClause("workspace_id", "?2")} ORDER BY created_at DESC, id DESC`
    : "SELECT * FROM initiative_updates WHERE initiative_id = ?1 ORDER BY created_at DESC, id DESC";
  return (
    workspaceId ? db.query(query).all(initiativeId, workspaceId) : db.query(query).all(initiativeId)
  ) as Array<Record<string, unknown>>;
}

export function createInitiativeUpdate(
  db: Database,
  initiativeId: string,
  authorId: string,
  input: { body: string; health?: string | null },
  workspaceId?: string,
): Record<string, unknown> {
  const initiative = getInitiative(db, initiativeId, workspaceId);
  if (!initiative) throw apiError("NOT_FOUND", "Initiative not found");
  const body = input.body.trim();
  if (!body) throw apiError("VALIDATION_FAILED", "Initiative update body cannot be empty");
  const health = input.health ?? "on_track";
  if (!["on_track", "at_risk", "off_track"].includes(health))
    throw apiError("VALIDATION_FAILED", `Invalid initiative update health: ${health}`);
  const id = newId();
  const timestamp = now();
  db.query(
    "INSERT INTO initiative_updates (id, initiative_id, author_id, health, body, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
  ).run(id, initiativeId, authorId, health, body, timestamp, workspaceId ?? null);
  return db.query("SELECT * FROM initiative_updates WHERE id = ?1").get(id) as Record<
    string,
    unknown
  >;
}

export function deleteInitiativeUpdate(db: Database, id: string, workspaceId?: string): boolean {
  const result = workspaceId
    ? db
        .query(
          `DELETE FROM initiative_updates WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
        )
        .run(id, workspaceId)
    : db.query("DELETE FROM initiative_updates WHERE id = ?1").run(id);
  if (!result.changes) throw apiError("NOT_FOUND", "Initiative update not found");
  return true;
}

export function initiativeProgress(
  db: Database,
  initiativeId: string,
  workspaceId?: string,
): { totalIssues: number; completedIssues: number; progress: number } {
  const query = workspaceId
    ? `SELECT count(*) AS total,
              sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
       FROM issues
       JOIN workflow_states ON workflow_states.id = issues.state_id
       WHERE issues.archived_at IS NULL
         AND issues.workspace_id = ?2
         AND issues.project_id IN (
           SELECT project_id FROM initiative_projects WHERE initiative_id = ?1 AND workspace_id = ?2
         )`
    : `SELECT count(*) AS total,
              sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
       FROM issues
       JOIN workflow_states ON workflow_states.id = issues.state_id
       WHERE issues.archived_at IS NULL
         AND issues.project_id IN (
           SELECT project_id FROM initiative_projects WHERE initiative_id = ?1
         )`;
  const row = db
    .query(query)
    .get(...(workspaceId ? [initiativeId, workspaceId] : [initiativeId])) as {
    total: number;
    done: number | null;
  };
  const totalIssues = row.total;
  const completedIssues = row.done ?? 0;
  return {
    totalIssues,
    completedIssues,
    progress: totalIssues === 0 ? 0 : completedIssues / totalIssues,
  };
}
