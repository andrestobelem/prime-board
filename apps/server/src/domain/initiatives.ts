// Iniciativas de workspace (PRB-206).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getProject, listProjectTeamIds } from "./projects.ts";
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
  target_date: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  workspace_id: string | null;
}

type ViewerRef = string | ActorRow;

function resolveViewer(db: Database, viewer: ViewerRef): ActorRow | null {
  if (typeof viewer !== "string") return viewer;
  return db.query("SELECT * FROM actors WHERE id = ?1").get(viewer) as ActorRow | null;
}

function viewerId(viewer: ViewerRef): string {
  return typeof viewer === "string" ? viewer : viewer.id;
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
    for (const teamId of listProjectTeamIds(db, projectId)) teamIds.add(teamId);
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
    if (!getProject(db, projectId)) throw apiError("NOT_FOUND", `Project not found: ${projectId}`);
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
    targetDate?: string | null;
    projectIds?: string[] | null;
    teamIds?: string[] | null;
  },
  workspaceId?: string,
): InitiativeRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Initiative name cannot be empty");
  if (input.targetDate != null) parseDateTime(input.targetDate, "targetDate");
  const ownerId = viewerId(ownerRef);
  const id = newId();
  const timestamp = now();
  const state = input.state ? resolveState(input.state) : "planned";
  db.transaction(() => {
    db.query(
      `INSERT INTO initiatives
        (id, name, description, state, target_date, owner_id, created_at, updated_at, archived_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL, ?8)`,
    ).run(
      id,
      name,
      input.description ?? null,
      state,
      input.targetDate ?? null,
      ownerId,
      timestamp,
      workspaceId ?? null,
    );
    if (input.projectIds?.length) setProjects(db, id, input.projectIds, ownerRef, workspaceId);
    if (input.teamIds !== undefined && input.teamIds !== null)
      setTeams(db, id, input.teamIds, ownerRef, workspaceId);
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
    targetDate?: string | null;
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
      if (sets.length === 0 && input.projectIds === undefined) {
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
