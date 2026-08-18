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

export function getTeamMembership(db: Database, id: string): TeamMembershipRow | null {
  return db
    .query("SELECT * FROM team_memberships WHERE id = ?1")
    .get(id) as TeamMembershipRow | null;
}

export function listTeamMemberships(db: Database, teamId: string): TeamMembershipRow[] {
  return db
    .query("SELECT * FROM team_memberships WHERE team_id = ?1 ORDER BY created_at, id")
    .all(teamId) as TeamMembershipRow[];
}

export function isTeamMember(db: Database, teamId: string, actorId: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM team_memberships WHERE team_id = ?1 AND actor_id = ?2")
      .get(teamId, actorId),
  );
}

export function isTeamOwner(db: Database, teamId: string, actorId: string): boolean {
  return Boolean(
    db
      .query(
        "SELECT 1 FROM team_memberships WHERE team_id = ?1 AND actor_id = ?2 AND role = 'owner'",
      )
      .get(teamId, actorId),
  );
}

export function assertTeamMember(db: Database, teamId: string, actorId: string): void {
  assertTeamActive(db, teamId);
  if (!isTeamMember(db, teamId, actorId)) throw apiError("NOT_FOUND", "Team resource not found");
}

function assertTeamOwner(db: Database, teamId: string, actorId: string, allowAdmin = false): void {
  if (!allowAdmin && !isTeamOwner(db, teamId, actorId)) {
    throw apiError("NOT_FOUND", "Team resource not found");
  }
}

export function createTeamMembership(
  db: Database,
  viewerId: string,
  input: { teamId: string; actorId: string; role?: string | null },
  allowAdmin = false,
): TeamMembershipRow {
  if (!getTeam(db, { id: input.teamId })) throw apiError("NOT_FOUND", "Team not found");
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
    "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(id, input.teamId, input.actorId, role, now());
  return getTeamMembership(db, id)!;
}

export function deleteTeamMembership(
  db: Database,
  viewerId: string,
  id: string,
  allowAdmin = false,
): boolean {
  const membership = getTeamMembership(db, id);
  if (!membership) throw apiError("NOT_FOUND", "Team membership not found");
  assertTeamActive(db, membership.team_id);
  assertTeamOwner(db, membership.team_id, viewerId, allowAdmin);
  if (membership.role === "owner") {
    const owners = db
      .query("SELECT count(*) AS count FROM team_memberships WHERE team_id = ?1 AND role = 'owner'")
      .get(membership.team_id) as { count: number };
    if (owners.count <= 1) throw apiError("VALIDATION_FAILED", "A team must keep one owner");
  }
  db.query("DELETE FROM team_memberships WHERE id = ?1").run(id);
  return true;
}
