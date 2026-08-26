// Membresía y permisos básicos de los teams (PRB-221).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getActor } from "./actors.ts";
import { assertTeamActive, getTeam } from "./teams.ts";

export type TeamMembershipRole = "owner" | "member";

export interface TeamMembershipRow {
  id: string;
  team_id: string;
  actor_id: string;
  role: TeamMembershipRole;
  created_at: string;
  workspace_id?: string | null;
}

/** Las filas legacy con NULL solo son visibles con un único Workspace. */
function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

function resolveLegacyWorkspaceId(db: Database): string | null {
  const workspace = db
    .query(
      "SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1 ORDER BY created_at, id",
    )
    .get() as { id: string } | null;
  return workspace?.id ?? null;
}

export function mapTeamMembership(row: TeamMembershipRow) {
  return {
    id: row.id,
    teamId: row.team_id,
    actorId: row.actor_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function getTeamMembership(
  db: Database,
  id: string,
  workspaceId?: string,
): TeamMembershipRow | null {
  const query = workspaceId
    ? `SELECT * FROM team_memberships
       WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM team_memberships WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as TeamMembershipRow | null;
}

export function listTeamMemberships(
  db: Database,
  teamId: string,
  workspaceId?: string,
): TeamMembershipRow[] {
  const query = workspaceId
    ? `SELECT * FROM team_memberships
       WHERE team_id = ?1 AND ${workspaceClause("workspace_id", "?2")}
       ORDER BY created_at, id`
    : "SELECT * FROM team_memberships WHERE team_id = ?1 ORDER BY created_at, id";
  return (
    workspaceId ? db.query(query).all(teamId, workspaceId) : db.query(query).all(teamId)
  ) as TeamMembershipRow[];
}

export function isTeamMember(db: Database, teamId: string, actorId: string): boolean {
  return Boolean(
    db
      .query(
        `SELECT 1
         FROM team_memberships
         JOIN teams ON teams.id = team_memberships.team_id
         JOIN workspace_memberships
           ON workspace_memberships.workspace_id = teams.workspace_id
          AND workspace_memberships.actor_id = team_memberships.actor_id
          AND workspace_memberships.status = 'active'
         WHERE team_memberships.team_id = ?1 AND team_memberships.actor_id = ?2`,
      )
      .get(teamId, actorId),
  );
}

export function isTeamOwner(
  db: Database,
  teamId: string,
  actorId: string,
  workspaceId?: string,
): boolean {
  const workspaceCondition = workspaceId
    ? `AND ${workspaceClause("teams.workspace_id", "?3")}
           AND ${workspaceClause("team_memberships.workspace_id", "?3")}`
    : "";
  const query = `
    SELECT 1
      FROM team_memberships
      JOIN teams ON teams.id = team_memberships.team_id
      JOIN workspace_memberships
        ON workspace_memberships.workspace_id = COALESCE(
             teams.workspace_id,
             (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1)
           )
       AND workspace_memberships.actor_id = team_memberships.actor_id
       AND workspace_memberships.status = 'active'
     WHERE team_memberships.team_id = ?1
       AND team_memberships.actor_id = ?2
       AND team_memberships.role = 'owner'
       ${workspaceCondition}`;
  return Boolean(
    workspaceId
      ? db.query(query).get(teamId, actorId, workspaceId)
      : db.query(query).get(teamId, actorId),
  );
}

export function assertTeamMember(db: Database, teamId: string, actorId: string): void {
  assertTeamActive(db, teamId);
  if (!isTeamMember(db, teamId, actorId)) throw apiError("NOT_FOUND", "Team resource not found");
}

function isWorkspaceAdminForTeam(
  db: Database,
  teamId: string,
  actorId: string,
  workspaceId?: string,
): boolean {
  const query = workspaceId
    ? `SELECT workspace_id FROM teams
       WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT workspace_id FROM teams WHERE id = ?1";
  const team = (
    workspaceId ? db.query(query).get(teamId, workspaceId) : db.query(query).get(teamId)
  ) as { workspace_id: string | null } | null;
  if (!team) return false;

  let teamWorkspaceId = team.workspace_id;
  if (!teamWorkspaceId) {
    teamWorkspaceId = workspaceId ?? resolveLegacyWorkspaceId(db);
  }
  if (!teamWorkspaceId) return false;

  return Boolean(
    db
      .query(
        `SELECT 1
         FROM workspace_memberships
         WHERE workspace_id = ?1
           AND actor_id = ?2
           AND role = 'admin'
           AND status = 'active'`,
      )
      .get(teamWorkspaceId, actorId),
  );
}

function assertTeamActiveInWorkspace(db: Database, teamId: string, workspaceId: string): void {
  const team = db
    .query(
      `SELECT archived_at
         FROM teams
        WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
    )
    .get(teamId, workspaceId) as { archived_at: string | null } | null;
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
}

function assertTeamOwner(
  db: Database,
  teamId: string,
  actorId: string,
  allowAdmin = false,
  workspaceId?: string,
): void {
  if (allowAdmin && isWorkspaceAdminForTeam(db, teamId, actorId, workspaceId)) return;
  if (!isTeamOwner(db, teamId, actorId, workspaceId)) {
    throw apiError("NOT_FOUND", "Team resource not found");
  }
}

export function createTeamMembership(
  db: Database,
  viewerId: string,
  input: { teamId: string; actorId: string; role?: string | null },
  allowAdmin = false,
): TeamMembershipRow {
  const team = getTeam(db, { id: input.teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  assertTeamActive(db, input.teamId);
  if (!getActor(db, input.actorId)) throw apiError("NOT_FOUND", "Actor not found");
  assertTeamOwner(db, input.teamId, viewerId, allowAdmin);
  const role = (input.role ?? "member").toLowerCase() as TeamMembershipRole;
  if (role !== "member" && role !== "owner") {
    throw apiError("VALIDATION_FAILED", `Invalid team membership role: ${input.role}`);
  }
  const duplicate = db
    .query("SELECT id FROM team_memberships WHERE team_id = ?1 AND actor_id = ?2")
    .get(input.teamId, input.actorId);
  if (duplicate) throw apiError("VALIDATION_FAILED", "Actor is already a team member");
  const id = newId();
  db.query(
    "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(
    id,
    input.teamId,
    input.actorId,
    role,
    now(),
    (team as { workspace_id?: string | null }).workspace_id ?? null,
  );
  return getTeamMembership(db, id)!;
}

export function deleteTeamMembership(
  db: Database,
  viewerId: string,
  id: string,
  allowAdmin = false,
  workspaceId?: string,
): boolean {
  const effectiveWorkspaceId = workspaceId ?? resolveLegacyWorkspaceId(db);
  if (!effectiveWorkspaceId) {
    throw apiError("NOT_FOUND", "Team membership requires a Workspace context");
  }
  return db.transaction(() => {
    // Resuelve el objetivo dentro del Workspace efectivo antes de comprobar
    // permisos. Un ID de otro Workspace debe parecer una membresía inexistente.
    const membership = getTeamMembership(db, id, effectiveWorkspaceId);
    if (!membership) throw apiError("NOT_FOUND", "Team membership not found");
    assertTeamActiveInWorkspace(db, membership.team_id, effectiveWorkspaceId);
    assertTeamOwner(db, membership.team_id, viewerId, allowAdmin, effectiveWorkspaceId);
    if (membership.role === "owner") {
      const owners = db
        .query(
          `SELECT count(*) AS count
             FROM team_memberships
            WHERE team_id = ?1
              AND role = 'owner'
              AND ${workspaceClause("workspace_id", "?2")}`,
        )
        .get(membership.team_id, effectiveWorkspaceId) as { count: number };
      if (owners.count <= 1) throw apiError("VALIDATION_FAILED", "A team must keep one owner");
    }
    const deleted = db
      .query(
        `DELETE FROM team_memberships
          WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`,
      )
      .run(id, effectiveWorkspaceId);
    if (deleted.changes !== 1) throw apiError("NOT_FOUND", "Team membership not found");
    return true;
  })();
}
