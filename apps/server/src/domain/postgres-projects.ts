import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { parseDateTime } from "./datetime.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import {
  assertPostgresTeamActive,
  canDiscoverPostgresTeam,
  canWritePostgresTeam,
  getPostgresTeam,
  listPostgresTeams,
} from "./postgres-teams.ts";
import { newId, now } from "../db/util.ts";
import { PROJECT_STATES } from "./projects.ts";
import type { ActorRow, AuthScopeContext, PlanningAuthorizationHooks } from "../auth/viewer.ts";

export interface PostgresProjectRow {
  id: string;
  name: string;
  description: string | null;
  state: (typeof PROJECT_STATES)[number];
  lead_id: string | null;
  target_date: string | null;
  start_date: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export const POSTGRES_PROJECT_DEPENDENCY_TYPES = ["blocks", "related"] as const;
export type PostgresProjectDependencyType = (typeof POSTGRES_PROJECT_DEPENDENCY_TYPES)[number];

export interface PostgresProjectDependencyRow {
  id: string;
  project_id: string;
  depends_on_project_id: string;
  type: PostgresProjectDependencyType;
  created_at: string;
}

export interface PostgresProjectInput {
  name: string;
  description?: string | null;
  state?: string | null;
  leadId?: string | null;
  targetDate?: string | null;
  startDate?: string | null;
  memberIds?: string[] | null;
  dependencyIds?: string[] | null;
  teamIds?: string[] | null;
}

export interface PostgresProjectUpdateInput {
  name?: string | null;
  description?: string | null;
  state?: string | null;
  leadId?: string | null;
  targetDate?: string | null;
  startDate?: string | null;
  memberIds?: string[] | null;
  dependencyIds?: string[] | null;
  teamIds?: string[] | null;
}

export function mapPostgresProject(row: PostgresProjectRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    leadId: row.lead_id,
    targetDate: row.target_date,
    startDate: row.start_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export async function getPostgresProject(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresProjectRow | null> {
  return persistence.one<PostgresProjectRow>("SELECT * FROM projects WHERE id = $1", [id]);
}

export async function listPostgresProjectTeamIds(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
): Promise<string[]> {
  const rows = await persistence.many<{ team_id: string }>(
    "SELECT team_id FROM project_teams WHERE project_id = $1 ORDER BY team_id",
    [projectId],
  );
  return rows.map((row) => row.team_id);
}

export async function listPostgresProjects(
  persistence: Persistence,
  state?: string | null,
  teamId?: string | null,
  includeArchived = false,
): Promise<PostgresProjectRow[]> {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (!includeArchived) clauses.push("projects.archived_at IS NULL");
  if (state) {
    params.push(state);
    clauses.push(`projects.state = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    clauses.push(
      `EXISTS (SELECT 1 FROM project_teams WHERE project_teams.project_id = projects.id AND project_teams.team_id = $${params.length})`,
    );
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return [
    ...(await persistence.many<PostgresProjectRow>(
      `SELECT projects.* FROM projects${where} ORDER BY projects.created_at, projects.id`,
      params,
    )),
  ];
}

async function validateLead(
  persistence: Persistence | PersistenceTransaction,
  leadId: string | null | undefined,
): Promise<void> {
  if (leadId === undefined || leadId === null) return;
  if (!(await getPostgresActor(persistence, leadId))) {
    throw apiError("NOT_FOUND", "Lead actor not found");
  }
}

function validateProjectFields(input: {
  name?: string | null;
  state?: string | null;
  targetDate?: string | null;
  startDate?: string | null;
}): void {
  if (input.name !== undefined && input.name !== null && !input.name.trim()) {
    throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
  }
  if (
    input.state !== undefined &&
    input.state !== null &&
    !PROJECT_STATES.some((state) => state === input.state)
  ) {
    throw apiError("VALIDATION_FAILED", `Invalid project state: ${input.state}`);
  }
  if (input.targetDate !== undefined && input.targetDate !== null) {
    parseDateTime(input.targetDate, "targetDate");
  }
  if (input.startDate !== undefined && input.startDate !== null) {
    parseDateTime(input.startDate, "startDate");
  }
  if (input.startDate != null && input.targetDate != null && input.startDate > input.targetDate) {
    throw apiError("VALIDATION_FAILED", "Project startDate cannot be after targetDate");
  }
}

async function validateProjectTeams(
  persistence: Persistence,
  viewer: ActorRow,
  teamIds: readonly string[],
): Promise<string[]> {
  const uniqueTeamIds = [...new Set(teamIds)];
  if (uniqueTeamIds.length === 0) {
    throw apiError("VALIDATION_FAILED", "A project must belong to at least one team");
  }
  for (const teamId of uniqueTeamIds) {
    const team = await assertPostgresTeamActive(persistence, teamId);
    if (!(await canWritePostgresTeam(persistence, viewer, team.id))) {
      throw apiError("UNAUTHORIZED", "Project access policy does not allow this operation");
    }
  }
  return uniqueTeamIds;
}

async function postgresProjectHasMember(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
  actorId: string,
): Promise<boolean> {
  return Boolean(
    await persistence.one("SELECT 1 FROM project_members WHERE project_id = $1 AND actor_id = $2", [
      projectId,
      actorId,
    ]),
  );
}

export async function canAccessPostgresProject(
  persistence: Persistence | PersistenceTransaction,
  viewer: Pick<ActorRow, "id" | "workspace_role">,
  projectId: string,
): Promise<boolean> {
  const teamIds = await listPostgresProjectTeamIds(persistence, projectId);
  if (viewer.workspace_role === "admin") return true;
  if (await postgresProjectHasMember(persistence, projectId, viewer.id)) return true;
  if (teamIds.length === 0) return false;
  for (const teamId of teamIds) {
    const team = await getPostgresTeam(persistence, { id: teamId });
    if (!team || !(await canDiscoverPostgresTeam(persistence, viewer, team))) return false;
  }
  return true;
}

export async function assertCanManagePostgresProject(
  persistence: Persistence | PersistenceTransaction,
  viewer: ActorRow,
  projectId: string,
): Promise<PostgresProjectRow> {
  const project = await getPostgresProject(persistence, projectId);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  const teamIds = await listPostgresProjectTeamIds(persistence, projectId);
  if (
    viewer.workspace_role !== "admin" &&
    (await postgresProjectHasMember(persistence, projectId, viewer.id))
  )
    return project;
  if (teamIds.length === 0) throw apiError("NOT_FOUND", "Project not found");
  if (viewer.workspace_role !== "admin") {
    for (const teamId of teamIds) {
      if (!(await canWritePostgresTeam(persistence, viewer, teamId))) {
        throw apiError("UNAUTHORIZED", "Project access policy does not allow this operation");
      }
    }
  }
  return project;
}

export async function listPostgresProjectMemberIds(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
): Promise<string[]> {
  const rows = await persistence.many<{ actor_id: string }>(
    "SELECT actor_id FROM project_members WHERE project_id = $1 ORDER BY actor_id",
    [projectId],
  );
  return rows.map((row) => row.actor_id);
}

export async function listPostgresProjectDependencyRows(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
): Promise<readonly PostgresProjectDependencyRow[]> {
  return persistence.many<PostgresProjectDependencyRow>(
    "SELECT id, project_id, depends_on_project_id, type, created_at FROM project_dependencies WHERE project_id = $1 ORDER BY created_at, id",
    [projectId],
  );
}

/**
 * Orden global de locks de Planning en PostgreSQL.
 *
 * 1. Se bloquean las raíces en un orden fijo por recurso (Initiative y luego Project), con IDs
 *    ascendentes dentro de cada recurso.
 * 2. Se bloquean las relaciones de Project por Project e identificador ascendente.
 * 3. Se bloquean las relaciones de Initiative por identificador ascendente.
 * 4. Se bloquean todos los Teams del alcance una sola vez y por identificador ascendente.
 * 5. Se bloquean las filas secundarias, como dependencies y updates.
 *
 * Las operaciones que reciben un AuthScopeContext bloquean antes la fila raíz de la API key y
 * sus límites. Ese lock protege el scope capturado y precede a este orden de recursos.
 * Nunca se debe bloquear una fila secundaria antes de su raíz.
 */
export async function lockPostgresTeamIds(
  tx: PersistenceTransaction,
  teamIds: readonly string[],
): Promise<void> {
  for (const teamId of [...new Set(teamIds)].sort()) {
    const team = await tx.one<{ id: string }>("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [
      teamId,
    ]);
    if (!team) throw apiError("NOT_FOUND", "Team not found");
  }
}

/**
 * Bloquea las raíces de Projects y sus relaciones con Teams, pero no bloquea los Teams.
 *
 * Este paso permite que un caller que también tiene relaciones de Initiative bloquee todas las
 * relaciones antes de adquirir cualquier Team. Las mutaciones de Projects bloquean la fila raíz
 * antes de reemplazar esas relaciones.
 */
export async function lockPostgresProjectRelations(
  tx: PersistenceTransaction,
  projectIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(projectIds)].sort();
  for (const projectId of ids) {
    const project = await tx.one<{ id: string }>(
      "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
      [projectId],
    );
    if (!project) throw apiError("NOT_FOUND", "Project not found");
  }

  const teamIds = new Set<string>();
  for (const projectId of ids) {
    const rows = await tx.many<{ team_id: string }>(
      "SELECT team_id FROM project_teams WHERE project_id = $1 ORDER BY team_id FOR UPDATE",
      [projectId],
    );
    for (const row of rows) teamIds.add(row.team_id);
  }
  return [...teamIds].sort();
}

/**
 * Bloquea Projects, sus relaciones con Teams y los Teams del alcance antes de autorizar una
 * mutación. Los IDs adicionales permiten incluir relaciones nuevas en una mutación de Initiative
 * sin adquirir locks después de los Teams actuales.
 */
export async function lockPostgresProjectScope(
  tx: PersistenceTransaction,
  projectIds: readonly string[],
  additionalTeamIds: readonly string[] = [],
): Promise<string[]> {
  const projectTeamIds = await lockPostgresProjectRelations(tx, projectIds);
  const teamIds = [...new Set([...projectTeamIds, ...additionalTeamIds])].sort();
  await lockPostgresTeamIds(tx, teamIds);
  return teamIds;
}

/**
 * Releeva el límite del grant dentro de la misma transacción que la mutación.
 * El keyId identifica la credencial; nunca se persiste el bearer secreto.
 */
export async function readPostgresAuthScope(
  tx: PersistenceTransaction,
  auth: AuthScopeContext | null | undefined,
  workspaceId?: string,
): Promise<AuthScopeContext | null | undefined> {
  if (!auth || auth.keyId === "local") return auth;
  const key = await tx.one<{ id: string; revoked_at: string | null; expires_at: string | null }>(
    "SELECT id, revoked_at, expires_at FROM api_keys WHERE id = $1 FOR UPDATE",
    [auth.keyId],
  );
  if (!key || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= Date.now())) {
    throw apiError("UNAUTHORIZED", "API key authorization changed");
  }
  const rows = await tx.many<{ team_id: string }>(
    workspaceId
      ? "SELECT team_id FROM api_key_team_limits WHERE api_key_id = $1 AND workspace_id = $2 ORDER BY team_id FOR UPDATE"
      : "SELECT team_id FROM api_key_team_limits WHERE api_key_id = $1 ORDER BY team_id FOR UPDATE",
    workspaceId ? [auth.keyId, workspaceId] : [auth.keyId],
  );
  const currentTeamIds = rows.length ? rows.map((row) => row.team_id) : null;
  const capturedTeamIds = auth.teamIds ? [...auth.teamIds].sort() : null;
  const currentSorted = currentTeamIds ? [...currentTeamIds].sort() : null;
  if (
    capturedTeamIds === null
      ? currentSorted !== null
      : currentSorted === null ||
        capturedTeamIds.length !== currentSorted.length ||
        capturedTeamIds.some((teamId, index) => teamId !== currentSorted[index])
  ) {
    throw apiError("UNAUTHORIZED", "API key authorization changed");
  }
  return { keyId: auth.keyId, teamIds: currentTeamIds };
}

function assertPostgresProjectTeamLimit(
  auth: AuthScopeContext | null | undefined,
  teamIds: readonly string[],
): void {
  if (!auth?.teamIds) return;
  const allowed = new Set(auth.teamIds);
  if (teamIds.length === 0 || teamIds.some((teamId) => !allowed.has(teamId))) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
}

function resolvePostgresProjectDependencyType(
  type: string | null | undefined,
): PostgresProjectDependencyType {
  const normalized = type?.toLowerCase();
  if (normalized === undefined || normalized === "blocks") return "blocks";
  if (normalized === "related") return "related";
  throw apiError("VALIDATION_FAILED", `Invalid project dependency type: ${type}`);
}

/**
 * Las tablas de planning de PostgreSQL son de instalación mientras el backend
 * conserva el contrato de un único Workspace. Validar el contexto antes de
 * resolver IDs evita usar un selector vencido o de otro Workspace.
 */
export async function assertPostgresWorkspace(
  persistence: Persistence | PersistenceTransaction,
  workspaceId?: string,
): Promise<void> {
  if (workspaceId) {
    if (
      !(await persistence.one<{ id: string }>("SELECT id FROM workspace WHERE id = $1", [
        workspaceId,
      ]))
    ) {
      throw apiError("NOT_FOUND", "Workspace is not initialized");
    }
    return;
  }

  const workspaces = await persistence.many<{ id: string }>(
    "SELECT id FROM workspace ORDER BY created_at, id",
  );
  if (workspaces.length === 0) throw apiError("NOT_FOUND", "Workspace is not initialized");
  if (workspaces.length !== 1) {
    throw apiError("WORKSPACE_REQUIRED", "A Workspace selector is required");
  }
}

async function getPostgresProjectDependencyInWorkspace(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  workspaceId?: string,
  forUpdate = false,
): Promise<PostgresProjectDependencyRow | null> {
  await assertPostgresWorkspace(persistence, workspaceId);
  return persistence.one<PostgresProjectDependencyRow>(
    `SELECT id, project_id, depends_on_project_id, type, created_at
     FROM project_dependencies WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
}

export async function getPostgresProjectDependency(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  workspaceId?: string,
): Promise<PostgresProjectDependencyRow | null> {
  return getPostgresProjectDependencyInWorkspace(persistence, id, workspaceId);
}

export async function createPostgresProjectDependency(
  persistence: Persistence,
  input: { projectId: string; dependsOnProjectId: string; type?: string | null },
  workspaceId?: string,
  viewer?: ActorRow,
  auth?: AuthScopeContext | null,
  hooks?: PlanningAuthorizationHooks,
): Promise<PostgresProjectDependencyRow> {
  return persistence.transaction(async (tx) => {
    await assertPostgresWorkspace(tx, workspaceId);
    const type = resolvePostgresProjectDependencyType(input.type);
    if (input.projectId === input.dependsOnProjectId) {
      throw apiError("VALIDATION_FAILED", "A project cannot depend on itself");
    }
    await hooks?.beforeAuthorization?.();
    const effectiveAuth = await readPostgresAuthScope(tx, auth, workspaceId);
    await hooks?.afterAuthorization?.();

    // Bloquea ambos Projects, sus filas project_teams y cada Team referenciado.
    const teamIds = await lockPostgresProjectScope(tx, [input.projectId, input.dependsOnProjectId]);
    const source = await tx.one<PostgresProjectRow>("SELECT * FROM projects WHERE id = $1", [
      input.projectId,
    ]);
    if (!source) throw apiError("NOT_FOUND", "Project not found");
    const target = await tx.one<PostgresProjectRow>("SELECT * FROM projects WHERE id = $1", [
      input.dependsOnProjectId,
    ]);
    if (!target) throw apiError("NOT_FOUND", "Dependency project not found");
    if (viewer) {
      await assertCanManagePostgresProject(tx, viewer, source.id);
      await assertCanManagePostgresProject(tx, viewer, target.id);
    }
    assertPostgresProjectTeamLimit(effectiveAuth, teamIds);

    const id = newId();
    const timestamp = now();
    const row = await tx.one<PostgresProjectDependencyRow>(
      `INSERT INTO project_dependencies
       (id, project_id, depends_on_project_id, type, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id, depends_on_project_id, type, created_at`,
      [id, source.id, target.id, type, timestamp],
    );
    if (!row) throw new Error("PostgreSQL project dependency insert returned no row");
    return row;
  });
}

export async function deletePostgresProjectDependency(
  persistence: Persistence,
  id: string,
  workspaceId?: string,
  viewer?: ActorRow,
  auth?: AuthScopeContext | null,
  hooks?: PlanningAuthorizationHooks,
): Promise<boolean> {
  return persistence.transaction(async (tx) => {
    // Lee la relación sin lock. Las dos raíces de Project deben adquirirse antes de la fila de
    // dependency para que updatePostgresProject y este delete no formen un ciclo de locks.
    let dependency = await getPostgresProjectDependencyInWorkspace(tx, id, workspaceId);
    if (!dependency) throw apiError("NOT_FOUND", "Project dependency not found");
    await hooks?.beforeAuthorization?.();
    const effectiveAuth = await readPostgresAuthScope(tx, auth, workspaceId);
    await hooks?.afterAuthorization?.();
    const teamIds = await lockPostgresProjectScope(tx, [
      dependency.project_id,
      dependency.depends_on_project_id,
    ]);
    dependency = await getPostgresProjectDependencyInWorkspace(tx, id, workspaceId, true);
    if (!dependency) throw apiError("NOT_FOUND", "Project dependency not found");
    const source = await getPostgresProject(tx, dependency.project_id);
    const target = await getPostgresProject(tx, dependency.depends_on_project_id);
    if (!source || !target) throw apiError("NOT_FOUND", "Project dependency not found");
    if (viewer) {
      await assertCanManagePostgresProject(tx, viewer, source.id);
      await assertCanManagePostgresProject(tx, viewer, target.id);
    }
    assertPostgresProjectTeamLimit(effectiveAuth, teamIds);

    const result = await tx.execute<PostgresProjectDependencyRow>(
      `DELETE FROM project_dependencies WHERE id = $1
       RETURNING id, project_id, depends_on_project_id, type, created_at`,
      [id],
    );
    if (result.rowCount !== 1) throw apiError("NOT_FOUND", "Project dependency not found");
    return true;
  });
}

async function validateProjectMembers(
  persistence: Persistence | PersistenceTransaction,
  memberIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(memberIds)];
  for (const actorId of unique) {
    if (!(await getPostgresActor(persistence, actorId)))
      throw apiError("NOT_FOUND", `Project member not found: ${actorId}`);
  }
  return unique;
}

async function validateProjectDependencies(
  persistence: Persistence | PersistenceTransaction,
  projectId: string,
  dependencyIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(dependencyIds)];
  for (const dependencyId of unique) {
    if (dependencyId === projectId)
      throw apiError("VALIDATION_FAILED", "A project cannot depend on itself");
    if (!(await getPostgresProject(persistence, dependencyId)))
      throw apiError("NOT_FOUND", `Dependency project not found: ${dependencyId}`);
  }
  return unique;
}

export async function createPostgresProject(
  persistence: Persistence,
  viewer: ActorRow,
  input: PostgresProjectInput,
): Promise<PostgresProjectRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Project name cannot be empty");
  validateProjectFields(input);
  await validateLead(persistence, input.leadId);
  const members = await validateProjectMembers(persistence, input.memberIds ?? []);
  const dependencies = await validateProjectDependencies(
    persistence,
    "",
    input.dependencyIds ?? [],
  );
  const teams =
    input.teamIds == null
      ? (await listPostgresTeams(persistence)).map((team) => team.id)
      : input.teamIds;
  const teamIds = await validateProjectTeams(persistence, viewer, teams);
  const id = newId();
  const timestamp = now();
  await persistence.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO projects
       (id, name, description, state, lead_id, target_date, start_date, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NULL)`,
      [
        id,
        name,
        input.description ?? null,
        input.state ?? "backlog",
        input.leadId ?? null,
        input.targetDate ?? null,
        input.startDate ?? null,
        timestamp,
      ],
    );
    for (const teamId of teamIds) {
      await tx.execute("INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2)", [
        id,
        teamId,
      ]);
    }
    for (const actorId of members) {
      await tx.execute(
        "INSERT INTO project_members (project_id, actor_id, created_at) VALUES ($1, $2, $3)",
        [id, actorId, timestamp],
      );
    }
    for (const dependencyId of dependencies) {
      await tx.execute(
        "INSERT INTO project_dependencies (id, project_id, depends_on_project_id, type, created_at) VALUES ($1, $2, $3, 'blocks', $4)",
        [newId(), id, dependencyId, timestamp],
      );
    }
  });
  const project = await getPostgresProject(persistence, id);
  if (!project) throw new Error("PostgreSQL project insert returned no row");
  return project;
}

export async function updatePostgresProject(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  input: PostgresProjectUpdateInput,
): Promise<PostgresProjectRow> {
  const existing = await assertCanManagePostgresProject(persistence, viewer, id);
  validateProjectFields(input);
  await validateLead(persistence, input.leadId);
  const memberIds =
    input.memberIds === undefined
      ? null
      : await validateProjectMembers(persistence, input.memberIds ?? []);
  const dependencyIds =
    input.dependencyIds === undefined
      ? null
      : await validateProjectDependencies(persistence, id, input.dependencyIds ?? []);
  const teamIds =
    input.teamIds === undefined
      ? null
      : await validateProjectTeams(persistence, viewer, input.teamIds ?? []);
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
    params.push(value);
  };
  if (input.name !== undefined && input.name !== null) push("name", input.name.trim());
  if (input.description !== undefined) push("description", input.description);
  if (input.state !== undefined && input.state !== null) push("state", input.state);
  if (input.leadId !== undefined) push("lead_id", input.leadId);
  if (input.targetDate !== undefined) push("target_date", input.targetDate);
  if (input.startDate !== undefined) push("start_date", input.startDate);
  await persistence.transaction(async (tx) => {
    // Las transacciones de dependency/status bloquean esta raíz antes de leer project_teams.
    const locked = await tx.one<{ id: string }>(
      "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!locked) throw apiError("NOT_FOUND", "Project not found");
    if (teamIds) {
      await tx.execute("DELETE FROM project_teams WHERE project_id = $1", [id]);
      for (const teamId of teamIds) {
        await tx.execute("INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2)", [
          id,
          teamId,
        ]);
      }
    }
    if (memberIds) {
      await tx.execute("DELETE FROM project_members WHERE project_id = $1", [id]);
      for (const actorId of memberIds)
        await tx.execute(
          "INSERT INTO project_members (project_id, actor_id, created_at) VALUES ($1, $2, $3)",
          [id, actorId, now()],
        );
    }
    if (dependencyIds) {
      await tx.execute("DELETE FROM project_dependencies WHERE project_id = $1", [id]);
      for (const dependencyId of dependencyIds)
        await tx.execute(
          "INSERT INTO project_dependencies (id, project_id, depends_on_project_id, type, created_at) VALUES ($1, $2, $3, 'blocks', $4)",
          [newId(), id, dependencyId, now()],
        );
    }
    if (sets.length || teamIds || memberIds || dependencyIds) {
      if (sets.length) {
        push("updated_at", now());
        params.push(id);
        const row = await tx.one<PostgresProjectRow>(
          `UPDATE projects SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
          params,
        );
        if (!row) throw apiError("NOT_FOUND", "Project not found");
      } else {
        await tx.execute("UPDATE projects SET updated_at = $1 WHERE id = $2", [now(), id]);
      }
    }
  });
  return (await getPostgresProject(persistence, existing.id))!;
}

export async function archivePostgresProject(
  persistence: Persistence,
  id: string,
  archived: boolean,
): Promise<PostgresProjectRow> {
  const project = await getPostgresProject(persistence, id);
  if (!project) throw apiError("NOT_FOUND", "Project not found");
  const archivedAt = archived ? (project.archived_at ?? now()) : null;
  const row = await persistence.one<PostgresProjectRow>(
    "UPDATE projects SET archived_at = $1, updated_at = $2 WHERE id = $3 RETURNING *",
    [archivedAt, now(), id],
  );
  if (!row) throw apiError("NOT_FOUND", "Project not found");
  return row;
}
