import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { DEFAULT_WORKFLOW } from "../db/defaults.ts";
import { newId, now } from "../db/util.ts";
import { apiError } from "../graphql/errors.ts";
import type { TeamRow, WorkflowStateRow } from "./teams.ts";

const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
type StateType = (typeof STATE_TYPES)[number];

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof Error && /unique|duplicate|23505/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function mapPostgresTeam(row: TeamRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    accessPolicy: row.access_policy,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    _row: row,
  };
}

export function mapPostgresWorkflowState(row: WorkflowStateRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    color: row.color,
    position: row.position,
  };
}

export async function getPostgresTeam(
  persistence: Persistence | PersistenceTransaction,
  ref: { id?: string | null; key?: string | null },
): Promise<TeamRow | null> {
  if (ref.id) return persistence.one<TeamRow>("SELECT * FROM teams WHERE id = $1", [ref.id]);
  if (ref.key) {
    return persistence.one<TeamRow>("SELECT * FROM teams WHERE key = $1", [ref.key.toUpperCase()]);
  }
  return null;
}

export async function listPostgresTeams(
  persistence: Persistence,
  includeArchived = false,
): Promise<TeamRow[]> {
  return [
    ...(await persistence.many<TeamRow>(
      `SELECT * FROM teams ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at`,
    )),
  ];
}

export async function assertPostgresTeamActive(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
): Promise<TeamRow> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
  return team;
}

export async function archivePostgresTeam(
  persistence: Persistence,
  id: string,
  archived: boolean,
): Promise<TeamRow> {
  const team = await getPostgresTeam(persistence, { id });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (archived && team.archived_at) return team;
  const row = await persistence.one<TeamRow>(
    "UPDATE teams SET archived_at = $1, updated_at = $2 WHERE id = $3 RETURNING *",
    [archived ? now() : null, now(), id],
  );
  if (!row) throw apiError("NOT_FOUND", "Team not found");
  return row;
}

function validateTeamInput(input: {
  name: string;
  key: string;
  visibility?: string | null;
  accessPolicy?: string | null;
}): {
  name: string;
  key: string;
  visibility: "public" | "private";
  accessPolicy: "workspace_members" | "team_members";
} {
  const name = input.name.trim();
  const key = input.key.trim().toUpperCase();
  if (!name) throw apiError("VALIDATION_FAILED", "Team name cannot be empty");
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(key)) {
    throw apiError(
      "VALIDATION_FAILED",
      "Team key must be 1-8 alphanumeric characters starting with a letter",
    );
  }
  const visibility = input.visibility ?? "public";
  const accessPolicy = input.accessPolicy ?? "team_members";
  if (visibility !== "public" && visibility !== "private") {
    throw apiError("VALIDATION_FAILED", "Team visibility must be public or private");
  }
  if (accessPolicy !== "workspace_members" && accessPolicy !== "team_members") {
    throw apiError("VALIDATION_FAILED", "Team access policy is invalid");
  }
  if (visibility === "private" && accessPolicy !== "team_members") {
    throw apiError("VALIDATION_FAILED", "Private Teams must restrict access to Team members");
  }
  return { name, key, visibility, accessPolicy };
}

async function seedPostgresWorkflow(tx: PersistenceTransaction, teamId: string, timestamp: string) {
  let firstId: string | null = null;
  for (const [index, state] of DEFAULT_WORKFLOW.entries()) {
    const id = newId();
    firstId ??= id;
    await tx.execute(
      `INSERT INTO workflow_states
       (id, team_id, name, type, color, position, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [id, teamId, state.name, state.type, state.color, index, timestamp],
    );
  }
  await tx.execute("UPDATE teams SET default_state_id = $1 WHERE id = $2", [firstId, teamId]);
}

export async function createPostgresTeam(
  persistence: Persistence,
  input: {
    name: string;
    key: string;
    description?: string | null;
    visibility?: "public" | "private" | null;
    accessPolicy?: "workspace_members" | "team_members" | null;
  },
  ownerId?: string,
): Promise<TeamRow> {
  const values = validateTeamInput(input);
  if (await getPostgresTeam(persistence, { key: values.key })) {
    throw apiError("VALIDATION_FAILED", `Team key ${values.key} is already in use`);
  }
  const id = newId();
  try {
    await persistence.transaction(async (tx) => {
      const timestamp = now();
      await tx.execute(
        `INSERT INTO teams
         (id, name, key, description, visibility, access_policy, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          id,
          values.name,
          values.key,
          input.description ?? null,
          values.visibility,
          values.accessPolicy,
          timestamp,
        ],
      );
      await seedPostgresWorkflow(tx, id, timestamp);
      if (ownerId) {
        await tx.execute(
          "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at) VALUES ($1, $2, $3, 'owner', $4)",
          [newId(), id, ownerId, timestamp],
        );
      }
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw apiError("VALIDATION_FAILED", `Team key ${values.key} is already in use`);
    throw error;
  }
  const row = await getPostgresTeam(persistence, { id });
  if (!row) throw new Error("PostgreSQL team insert returned no row");
  return row;
}

export interface PostgresTeamUpdateInput {
  name?: string | null;
  description?: string | null;
  defaultStateId?: string | null;
  visibility?: "public" | "private" | null;
  accessPolicy?: "workspace_members" | "team_members" | null;
}

export async function updatePostgresTeam(
  persistence: Persistence,
  id: string,
  input: PostgresTeamUpdateInput,
): Promise<TeamRow> {
  const team = await getPostgresTeam(persistence, { id });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
    params.push(value);
  };
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Team name cannot be empty");
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.defaultStateId != null) {
    const state = await persistence.one(
      "SELECT id FROM workflow_states WHERE id = $1 AND team_id = $2",
      [input.defaultStateId, team.id],
    );
    if (!state) throw apiError("VALIDATION_FAILED", "Default state must belong to the team");
    push("default_state_id", input.defaultStateId);
  }
  const visibility = input.visibility ?? team.visibility;
  const accessPolicy = input.accessPolicy ?? team.access_policy;
  if (visibility !== "public" && visibility !== "private") {
    throw apiError("VALIDATION_FAILED", "Team visibility must be public or private");
  }
  if (accessPolicy !== "workspace_members" && accessPolicy !== "team_members") {
    throw apiError("VALIDATION_FAILED", "Team access policy is invalid");
  }
  if (visibility === "private" && accessPolicy !== "team_members") {
    throw apiError("VALIDATION_FAILED", "Private Teams must restrict access to Team members");
  }
  if (input.visibility != null) push("visibility", visibility);
  if (input.accessPolicy != null) push("access_policy", accessPolicy);
  if (sets.length === 0) return team;
  push("updated_at", now());
  params.push(id);
  const row = await persistence.one<TeamRow>(
    `UPDATE teams SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  if (!row) throw apiError("NOT_FOUND", "Team not found");
  return row;
}

export async function getPostgresWorkflowState(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<WorkflowStateRow | null> {
  return persistence.one<WorkflowStateRow>("SELECT * FROM workflow_states WHERE id = $1", [id]);
}

export async function listPostgresTeamStates(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
): Promise<WorkflowStateRow[]> {
  return [
    ...(await persistence.many<WorkflowStateRow>(
      "SELECT * FROM workflow_states WHERE team_id = $1 ORDER BY position",
      [teamId],
    )),
  ];
}

export async function getPostgresDefaultState(
  persistence: Persistence,
  team: TeamRow,
): Promise<WorkflowStateRow> {
  if (team.default_state_id) {
    const state = await persistence.one<WorkflowStateRow>(
      "SELECT * FROM workflow_states WHERE id = $1 AND team_id = $2",
      [team.default_state_id, team.id],
    );
    if (state) return state;
  }
  const state = await persistence.one<WorkflowStateRow>(
    "SELECT * FROM workflow_states WHERE team_id = $1 ORDER BY position LIMIT 1",
    [team.id],
  );
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");
  return state;
}

export async function createPostgresWorkflowState(
  persistence: Persistence,
  input: {
    teamId: string;
    name: string;
    type: string;
    color?: string | null;
    position?: number | null;
  },
): Promise<WorkflowStateRow> {
  const team = await getPostgresTeam(persistence, { id: input.teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "State name cannot be empty");
  if (!STATE_TYPES.includes(input.type as StateType)) {
    throw apiError("VALIDATION_FAILED", `Invalid state type: ${input.type}`);
  }
  if (
    await persistence.one("SELECT id FROM workflow_states WHERE team_id = $1 AND name = $2", [
      team.id,
      name,
    ])
  ) {
    throw apiError("VALIDATION_FAILED", "State name already exists in this team");
  }
  const max = await persistence.one<{ max: number }>(
    "SELECT coalesce(max(position), -1) AS max FROM workflow_states WHERE team_id = $1",
    [team.id],
  );
  const id = newId();
  const timestamp = now();
  try {
    const row = await persistence.one<WorkflowStateRow>(
      `INSERT INTO workflow_states
       (id, team_id, name, type, color, position, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [
        id,
        team.id,
        name,
        input.type,
        input.color ?? "#95a2b3",
        input.position ?? (max?.max ?? -1) + 1,
        timestamp,
      ],
    );
    if (!row) throw new Error("PostgreSQL workflow state insert returned no row");
    return row;
  } catch (error) {
    if (isUniqueViolation(error))
      throw apiError("VALIDATION_FAILED", "State name already exists in this team");
    throw error;
  }
}

export async function updatePostgresWorkflowState(
  persistence: Persistence,
  id: string,
  input: {
    name?: string | null;
    type?: string | null;
    color?: string | null;
    position?: number | null;
  },
): Promise<WorkflowStateRow> {
  const state = await getPostgresWorkflowState(persistence, id);
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");
  if (input.type != null && !STATE_TYPES.includes(input.type as StateType)) {
    throw apiError("VALIDATION_FAILED", `Invalid state type: ${input.type}`);
  }
  if (input.type != null && input.type !== state.type && state.type === "completed") {
    const count = await persistence.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM workflow_states WHERE team_id = $1 AND type = 'completed' AND id <> $2",
      [state.team_id, id],
    );
    if ((count?.n ?? 0) === 0)
      throw apiError("VALIDATION_FAILED", "A team must keep at least one completed state");
  }
  let name: string | undefined;
  if (input.name != null) {
    name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "State name cannot be empty");
    if (
      await persistence.one(
        "SELECT id FROM workflow_states WHERE team_id = $1 AND name = $2 AND id <> $3",
        [state.team_id, name, id],
      )
    ) {
      throw apiError("VALIDATION_FAILED", "State name already exists in this team");
    }
  }
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
    params.push(value);
  };
  if (name !== undefined) push("name", name);
  if (input.type != null) push("type", input.type);
  if (input.color != null) push("color", input.color);
  if (input.position != null) push("position", input.position);
  if (!sets.length) return state;
  push("updated_at", now());
  params.push(id);
  try {
    const row = await persistence.one<WorkflowStateRow>(
      `UPDATE workflow_states SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!row) throw apiError("NOT_FOUND", "Workflow state not found");
    return row;
  } catch (error) {
    if (isUniqueViolation(error))
      throw apiError("VALIDATION_FAILED", "State name already exists in this team");
    throw error;
  }
}

async function preservePostgresStateActivityReferences(
  tx: PersistenceTransaction,
  stateId: string,
  reference: string,
): Promise<void> {
  const rows = await tx.many<{ id: string; payload: string }>(
    "SELECT id, payload FROM activity WHERE type IN ('state_changed', 'created')",
  );
  for (const activity of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(activity.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    let changed = false;
    for (const field of ["from", "to", "stateId"]) {
      if (payload[field] === stateId) {
        payload[field] = reference;
        changed = true;
      }
    }
    if (changed)
      await tx.execute("UPDATE activity SET payload = $1 WHERE id = $2", [
        JSON.stringify(payload),
        activity.id,
      ]);
  }
}

export async function deletePostgresWorkflowState(
  persistence: Persistence,
  actorId: string,
  id: string,
  moveToStateId?: string | null,
): Promise<number> {
  const state = await getPostgresWorkflowState(persistence, id);
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");
  const siblings = await persistence.many<WorkflowStateRow>(
    "SELECT * FROM workflow_states WHERE team_id = $1 AND id <> $2",
    [state.team_id, id],
  );
  if (!siblings.length)
    throw apiError("VALIDATION_FAILED", "A team must keep at least one workflow state");
  if (state.type === "completed" && !siblings.some((candidate) => candidate.type === "completed")) {
    throw apiError("VALIDATION_FAILED", "A team must keep at least one completed state");
  }
  const affected = await persistence.one<{ n: number }>(
    "SELECT count(*)::int AS n FROM issues WHERE state_id = $1",
    [id],
  );
  const affectedCount = affected?.n ?? 0;
  let target: WorkflowStateRow | null = null;
  if (affectedCount > 0) {
    if (!moveToStateId) {
      throw apiError(
        "VALIDATION_FAILED",
        `State has ${affectedCount} issue(s): provide moveToStateId to migrate them`,
      );
    }
    target = siblings.find((candidate) => candidate.id === moveToStateId) ?? null;
    if (!target)
      throw apiError("VALIDATION_FAILED", "moveToStateId must be another state of the same team");
  }
  const team = await getPostgresTeam(persistence, { id: state.team_id });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  return persistence.transaction(async (tx) => {
    if (target) {
      const issues = await tx.many<{ id: string }>("SELECT id FROM issues WHERE state_id = $1", [
        id,
      ]);
      await tx.execute("UPDATE issues SET state_id = $1, updated_at = $2 WHERE state_id = $3", [
        target.id,
        now(),
        id,
      ]);
      for (const issue of issues) {
        await tx.execute(
          "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES ($1, $2, $3, 'state_changed', $4, $5)",
          [
            newId(),
            issue.id,
            actorId,
            JSON.stringify({ from: id, to: target.id, reason: "state_deleted" }),
            now(),
          ],
        );
      }
    }
    const current = await tx.one<{ default_state_id: string | null }>(
      "SELECT default_state_id FROM teams WHERE id = $1 FOR UPDATE",
      [state.team_id],
    );
    if (current?.default_state_id === id) {
      const fallback = target ?? [...siblings].sort((a, b) => a.position - b.position)[0]!;
      await tx.execute("UPDATE teams SET default_state_id = $1, updated_at = $2 WHERE id = $3", [
        fallback.id,
        now(),
        state.team_id,
      ]);
    }
    await preservePostgresStateActivityReferences(tx, id, `${team.key}/${state.name}`);
    await tx.execute("DELETE FROM workflow_states WHERE id = $1", [id]);
    return affectedCount;
  });
}

export async function deletePostgresTeam(
  persistence: Persistence,
  id: string,
  confirmation: string,
): Promise<TeamRow> {
  const initial = await getPostgresTeam(persistence, { id });
  if (!initial) throw apiError("NOT_FOUND", "Team not found");
  if (confirmation !== initial.key) {
    throw apiError("VALIDATION_FAILED", `Confirmation must exactly match team key ${initial.key}`);
  }
  await persistence.transaction(async (tx) => {
    const team = await getPostgresTeam(tx, { id });
    if (!team) throw apiError("NOT_FOUND", "Team not found");
    if (confirmation !== team.key) {
      throw apiError("VALIDATION_FAILED", `Confirmation must exactly match team key ${team.key}`);
    }
    const dependencies: Array<[string, string]> = [
      ["issues", "SELECT count(*)::int AS count FROM issues WHERE team_id = $1"],
      ["projects", "SELECT count(*)::int AS count FROM project_teams WHERE team_id = $1"],
      ["cycles", "SELECT count(*)::int AS count FROM cycles WHERE team_id = $1"],
      ["labels", "SELECT count(*)::int AS count FROM labels WHERE team_id = $1"],
      ["saved views", "SELECT count(*)::int AS count FROM saved_views WHERE team_id = $1"],
      ["initiatives", "SELECT count(*)::int AS count FROM initiative_teams WHERE team_id = $1"],
      [
        "API key allowlists",
        "SELECT count(*)::int AS count FROM api_key_team_limits WHERE team_id = $1",
      ],
    ];
    const blockers: string[] = [];
    for (const [resource, statement] of dependencies) {
      const row = await tx.one<{ count: number }>(statement, [team.id]);
      if ((row?.count ?? 0) > 0) blockers.push(`${resource}=${row!.count}`);
    }
    if (blockers.length) {
      throw apiError(
        "VALIDATION_FAILED",
        `Cannot delete team ${team.key}: remove dependent resources first (${blockers.join(", ")})`,
      );
    }
    await tx.execute("UPDATE teams SET default_state_id = NULL WHERE id = $1", [team.id]);
    await tx.execute("DELETE FROM workflow_states WHERE team_id = $1", [team.id]);
    await tx.execute("DELETE FROM team_memberships WHERE team_id = $1", [team.id]);
    await tx.execute("DELETE FROM teams WHERE id = $1", [team.id]);
  });
  return initial;
}

export async function canDiscoverPostgresTeam(
  persistence: Persistence,
  viewer: { id: string; workspace_role: string },
  team: TeamRow,
): Promise<boolean> {
  if (viewer.workspace_role === "admin" || team.visibility === "public") return true;
  return Boolean(
    await persistence.one(
      `SELECT 1 FROM team_memberships
       JOIN actors ON actors.id = team_memberships.actor_id
       WHERE team_memberships.team_id = $1 AND team_memberships.actor_id = $2
         AND actors.status = 'active'`,
      [team.id, viewer.id],
    ),
  );
}

export async function isPostgresTeamOwner(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
  actorId: string,
): Promise<boolean> {
  return Boolean(
    await persistence.one(
      `SELECT 1 FROM team_memberships
       JOIN actors ON actors.id = team_memberships.actor_id
       WHERE team_memberships.team_id = $1 AND team_memberships.actor_id = $2
         AND team_memberships.role = 'owner' AND actors.status = 'active'`,
      [teamId, actorId],
    ),
  );
}

export type PostgresTeamMembershipRole = "owner" | "member";

export interface PostgresTeamMembershipRow {
  id: string;
  team_id: string;
  actor_id: string;
  role: PostgresTeamMembershipRole;
  created_at: string;
}

export function mapPostgresTeamMembership(row: PostgresTeamMembershipRow) {
  return {
    id: row.id,
    teamId: row.team_id,
    actorId: row.actor_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export async function getPostgresTeamMembership(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresTeamMembershipRow | null> {
  return persistence.one<PostgresTeamMembershipRow>(
    "SELECT * FROM team_memberships WHERE id = $1",
    [id],
  );
}

export async function listPostgresTeamMemberships(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
): Promise<PostgresTeamMembershipRow[]> {
  return [
    ...(await persistence.many<PostgresTeamMembershipRow>(
      "SELECT * FROM team_memberships WHERE team_id = $1 ORDER BY created_at, id",
      [teamId],
    )),
  ];
}

export async function isPostgresTeamMember(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
  actorId: string,
): Promise<boolean> {
  return Boolean(
    await persistence.one(
      `SELECT 1 FROM team_memberships
       JOIN actors ON actors.id = team_memberships.actor_id
       WHERE team_memberships.team_id = $1 AND team_memberships.actor_id = $2
         AND actors.status = 'active'`,
      [teamId, actorId],
    ),
  );
}

export async function canAccessPostgresTeam(
  persistence: Persistence,
  viewer: { id: string; workspace_role: string },
  teamId: string,
): Promise<boolean> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  return team ? canDiscoverPostgresTeam(persistence, viewer, team) : false;
}

export async function canWritePostgresTeam(
  persistence: Persistence,
  viewer: { id: string; workspace_role: string },
  teamId: string,
): Promise<boolean> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) return false;
  if (
    viewer.workspace_role === "admin" ||
    (await isPostgresTeamMember(persistence, teamId, viewer.id))
  ) {
    return true;
  }
  return team.visibility === "public" && team.access_policy === "workspace_members";
}

export async function assertCanAccessPostgresTeam(
  persistence: Persistence,
  viewer: { id: string; workspace_role: string },
  teamId: string,
): Promise<void> {
  if (!(await canAccessPostgresTeam(persistence, viewer, teamId))) {
    throw apiError("NOT_FOUND", "Team resource not found");
  }
}

export async function assertCanManagePostgresTeam(
  persistence: Persistence,
  viewer: { id: string; workspace_role: string },
  teamId: string,
): Promise<void> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) return;
  await assertCanAccessPostgresTeam(persistence, viewer, teamId);
  await assertPostgresTeamActive(persistence, teamId);
  if (viewer.workspace_role === "admin") return;
  if (!(await isPostgresTeamOwner(persistence, teamId, viewer.id))) {
    throw apiError("UNAUTHORIZED", "Team owner permission is required");
  }
}

export async function createPostgresTeamMembership(
  persistence: Persistence,
  viewerId: string,
  input: { teamId: string; actorId: string; role?: string | null },
  allowAdmin = false,
): Promise<PostgresTeamMembershipRow> {
  const id = newId();
  try {
    await persistence.transaction(async (tx) => {
      const team = await tx.one<TeamRow>("SELECT * FROM teams WHERE id = $1 FOR UPDATE", [
        input.teamId,
      ]);
      if (!team) throw apiError("NOT_FOUND", "Team not found");
      if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
      const actor = await tx.one("SELECT id FROM actors WHERE id = $1", [input.actorId]);
      if (!actor) throw apiError("NOT_FOUND", "Actor not found");
      if (!allowAdmin && !(await isPostgresTeamOwner(tx, team.id, viewerId))) {
        throw apiError("NOT_FOUND", "Team resource not found");
      }
      const role = (input.role ?? "member").toLowerCase();
      if (role !== "member" && role !== "owner") {
        throw apiError("VALIDATION_FAILED", `Invalid team membership role: ${input.role}`);
      }
      await tx.execute(
        `INSERT INTO team_memberships (id, team_id, actor_id, role, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, team.id, input.actorId, role, now()],
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw apiError("VALIDATION_FAILED", "Actor is already a team member");
    }
    throw error;
  }
  const membership = await getPostgresTeamMembership(persistence, id);
  if (!membership) throw new Error("PostgreSQL team membership insert returned no row");
  return membership;
}

export async function deletePostgresTeamMembership(
  persistence: Persistence,
  viewerId: string,
  id: string,
  allowAdmin = false,
): Promise<boolean> {
  return persistence.transaction(async (tx) => {
    const membership = await tx.one<PostgresTeamMembershipRow>(
      `SELECT team_memberships.* FROM team_memberships
       JOIN teams ON teams.id = team_memberships.team_id
       WHERE team_memberships.id = $1 FOR UPDATE`,
      [id],
    );
    if (!membership) throw apiError("NOT_FOUND", "Team membership not found");
    const team = await tx.one<TeamRow>("SELECT * FROM teams WHERE id = $1 FOR UPDATE", [
      membership.team_id,
    ]);
    if (!team) throw apiError("NOT_FOUND", "Team not found");
    if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
    if (!allowAdmin && !(await isPostgresTeamOwner(tx, team.id, viewerId))) {
      throw apiError("NOT_FOUND", "Team resource not found");
    }
    if (membership.role === "owner") {
      const owners = await tx.one<{ count: number }>(
        "SELECT count(*)::int AS count FROM team_memberships WHERE team_id = $1 AND role = 'owner'",
        [team.id],
      );
      if ((owners?.count ?? 0) <= 1) {
        throw apiError("VALIDATION_FAILED", "A team must keep one owner");
      }
    }
    await tx.execute("DELETE FROM team_memberships WHERE id = $1", [id]);
    return true;
  });
}
