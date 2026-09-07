// Dominio de teams: creación (con workflow default), lookup y mapeos.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { seedTeamWorkflow } from "../db/seed.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";

export interface TeamRow {
  id: string;
  workspace_id?: string | null;
  name: string;
  key: string;
  description: string | null;
  next_issue_number: number;
  default_state_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  visibility: "public" | "private";
  access_policy: "workspace_members" | "team_members";
  auto_close_period: number | null;
  auto_archive_period: number | null;
  auto_close_state_id: string | null;
  auto_close_parent_issues: boolean | number | null;
  auto_close_child_issues: boolean | number | null;
}

export interface WorkflowStateRow {
  id: string;
  workspace_id?: string | null;
  team_id: string;
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
  color: string;
  position: number;
  description: string | null;
  is_reserved: number | boolean;
}

export function mapTeam(row: TeamRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    accessPolicy: row.access_policy,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    autoClosePeriod: row.auto_close_period,
    autoArchivePeriod: row.auto_archive_period,
    autoCloseStateId: row.auto_close_state_id,
    autoCloseParentIssues:
      row.auto_close_parent_issues == null ? null : Boolean(row.auto_close_parent_issues),
    autoCloseChildIssues:
      row.auto_close_child_issues == null ? null : Boolean(row.auto_close_child_issues),
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
    description: row.description,
    isReserved: Boolean(row.is_reserved),
  };
}

export function getTeam(
  db: Database,
  ref: { id?: string | null; key?: string | null },
): TeamRow | null {
  if (ref.id) {
    return db.query("SELECT * FROM teams WHERE id = ?1").get(ref.id) as TeamRow | null;
  }
  if (ref.key) {
    return db
      .query("SELECT * FROM teams WHERE key = ?1")
      .get(ref.key.toUpperCase()) as TeamRow | null;
  }
  return null;
}

/** Rechaza mutaciones operativas sobre un Team archivado. */
export function assertTeamActive(db: Database, teamId: string): TeamRow {
  const team = getTeam(db, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
  return team;
}

/** Archiva o restaura un Team sin modificar sus recursos ni identificadores. */
export function archiveTeam(db: Database, id: string, archived: boolean): TeamRow {
  const team = getTeam(db, { id });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (archived && team.archived_at) return team;
  db.query("UPDATE teams SET archived_at = ?1, updated_at = ?2 WHERE id = ?3").run(
    archived ? now() : null,
    now(),
    id,
  );
  return getTeam(db, { id })!;
}

/**
 * Elimina definitivamente un Team vacío. Los estados y memberships son
 * dependencias internas y se eliminan dentro de la misma transacción; todo
 * recurso que conserva trabajo o referencias externas bloquea la operación.
 */
export function deleteTeam(db: Database, id: string, confirmation: string): TeamRow {
  const initial = getTeam(db, { id });
  if (!initial) throw apiError("NOT_FOUND", "Team not found");
  if (confirmation !== initial.key) {
    throw apiError("VALIDATION_FAILED", `Confirmation must exactly match team key ${initial.key}`);
  }

  db.transaction(() => {
    const team = getTeam(db, { id });
    if (!team) throw apiError("NOT_FOUND", "Team not found");
    if (confirmation !== team.key) {
      throw apiError("VALIDATION_FAILED", `Confirmation must exactly match team key ${team.key}`);
    }
    const dependencies: Array<[string, string]> = [
      ["issues", "SELECT count(*) AS count FROM issues WHERE team_id = ?1"],
      ["projects", "SELECT count(*) AS count FROM project_teams WHERE team_id = ?1"],
      ["cycles", "SELECT count(*) AS count FROM cycles WHERE team_id = ?1"],
      ["labels", "SELECT count(*) AS count FROM labels WHERE team_id = ?1"],
      ["saved views", "SELECT count(*) AS count FROM saved_views WHERE team_id = ?1"],
      ["initiatives", "SELECT count(*) AS count FROM initiative_teams WHERE team_id = ?1"],
      [
        "API key allowlists",
        "SELECT count(*) AS count FROM api_key_team_limits WHERE team_id = ?1",
      ],
    ];
    const blockers = dependencies
      .map(([resource, query]) => {
        const row = db.query(query).get(team.id) as { count: number };
        return [resource, row.count] as const;
      })
      .filter(([, count]) => count > 0)
      .map(([resource, count]) => `${resource}=${count}`);
    if (blockers.length > 0) {
      throw apiError(
        "VALIDATION_FAILED",
        `Cannot delete team ${team.key}: remove dependent resources first (${blockers.join(", ")})`,
      );
    }

    // These internal rows cannot outlive their Team and are removed atomically.
    db.query("DELETE FROM team_memberships WHERE team_id = ?1").run(team.id);
    // teams.default_state_id points back to workflow_states and must be cleared first.
    db.query("UPDATE teams SET default_state_id = NULL WHERE id = ?1").run(team.id);
    db.query("DELETE FROM workflow_states WHERE team_id = ?1").run(team.id);
    db.query("DELETE FROM teams WHERE id = ?1").run(team.id);
  })();

  return initial;
}

export function getWorkflowState(db: Database, id: string): WorkflowStateRow | null {
  return db.query("SELECT * FROM workflow_states WHERE id = ?1").get(id) as WorkflowStateRow | null;
}

export function listTeamStates(db: Database, teamId: string): WorkflowStateRow[] {
  return db
    .query("SELECT * FROM workflow_states WHERE team_id = ?1 ORDER BY position")
    .all(teamId) as WorkflowStateRow[];
}

export function createTeam(
  db: Database,
  input: {
    name: string;
    key: string;
    description?: string | null;
    visibility?: "public" | "private" | null;
    accessPolicy?: "workspace_members" | "team_members" | null;
    autoClosePeriod?: number | null;
    autoArchivePeriod?: number | null;
  },
  ownerId: string | undefined,
  workspaceId: string,
): TeamRow {
  const name = input.name.trim();
  const key = input.key.trim().toUpperCase();
  if (!name) throw apiError("VALIDATION_FAILED", "Team name cannot be empty");
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(key)) {
    throw apiError(
      "VALIDATION_FAILED",
      "Team key must be 1-8 alphanumeric characters starting with a letter",
    );
  }
  const duplicate = db
    .query("SELECT id FROM teams WHERE workspace_id = ?1 AND key = ?2")
    .get(workspaceId, key);
  if (duplicate) throw apiError("VALIDATION_FAILED", `Team key ${key} is already in use`);

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

  const autoClosePeriod =
    normalizeAutomationPeriod(input.autoClosePeriod, "autoClosePeriod") ?? null;
  const autoArchivePeriod =
    normalizeAutomationPeriod(input.autoArchivePeriod, "autoArchivePeriod") ?? null;
  const id = newId();
  db.transaction(() => {
    const timestamp = now();
    db.query(
      `INSERT INTO teams
       (id, workspace_id, name, key, description, visibility, access_policy,
        auto_close_period, auto_archive_period, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    ).run(
      id,
      workspaceId,
      name,
      key,
      input.description ?? null,
      visibility,
      accessPolicy,
      autoClosePeriod,
      autoArchivePeriod,
      timestamp,
    );
    seedTeamWorkflow(db, id, workspaceId);
    if (ownerId) {
      db.query(
        "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at, workspace_id) VALUES (?1, ?2, ?3, 'owner', ?4, ?5)",
      ).run(newId(), id, ownerId, timestamp, workspaceId);
    }
  })();
  return db.query("SELECT * FROM teams WHERE id = ?1").get(id) as TeamRow;
}

/**
 * El estado default explícito del team (AT-180); si nunca se fijó (datos previos
 * a la migración 0005), cae al de menor posición, que era la regla implícita.
 */
export function getDefaultState(db: Database, team: TeamRow): WorkflowStateRow {
  if (team.default_state_id) {
    const state = db
      .query("SELECT * FROM workflow_states WHERE id = ?1 AND team_id = ?2 AND is_reserved = 0")
      .get(team.default_state_id, team.id) as WorkflowStateRow | null;
    if (state) return state;
  }
  return db
    .query(
      "SELECT * FROM workflow_states WHERE team_id = ?1 AND is_reserved = 0 ORDER BY position LIMIT 1",
    )
    .get(team.id) as WorkflowStateRow;
}

export interface TeamUpdateInput {
  name?: string | null;
  description?: string | null;
  defaultStateId?: string | null;
  visibility?: "public" | "private" | null;
  accessPolicy?: "workspace_members" | "team_members" | null;
  /** Días de inactividad antes de que el worker de mantenimiento pueda cerrar issues. Null deshabilita la regla. */
  autoClosePeriod?: number | null;
  /** Días después del cierre antes de que el worker de mantenimiento pueda archivar issues. Null deshabilita la regla. */
  autoArchivePeriod?: number | null;
  /** Estado completed que usa auto-close. Null permite que el worker use el primero. */
  autoCloseStateId?: string | null;
  /** Indica si los issues padre participan en la elegibilidad de auto-close. */
  autoCloseParentIssues?: boolean | null;
  /** Indica si los issues hijo participan en la elegibilidad de auto-close. */
  autoCloseChildIssues?: boolean | null;
}

export function normalizeAutomationPeriod(
  value: number | null | undefined,
  field: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === 0) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw apiError("VALIDATION_FAILED", `${field} must be a positive number of days or null`);
  }
  return value;
}

export function updateTeam(
  db: Database,
  id: string,
  input: TeamUpdateInput,
  _workspaceId?: string,
): TeamRow {
  const team = getTeam(db, { id });
  if (!team) throw apiError("NOT_FOUND", "Team not found");

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Team name cannot be empty");
    push("name", name);
  }
  if (input.description !== undefined) push("description", input.description);
  if (input.defaultStateId != null) {
    const state = db
      .query("SELECT id, is_reserved FROM workflow_states WHERE id = ?1 AND team_id = ?2")
      .get(input.defaultStateId, team.id) as { id: string; is_reserved: number | boolean } | null;
    if (!state) throw apiError("VALIDATION_FAILED", "Default state must belong to the team");
    if (Boolean(state.is_reserved)) {
      throw apiError("VALIDATION_FAILED", "Duplicate cannot be the default workflow state");
    }
    push("default_state_id", input.defaultStateId);
  }
  const autoClosePeriod = normalizeAutomationPeriod(input.autoClosePeriod, "autoClosePeriod");
  const autoArchivePeriod = normalizeAutomationPeriod(input.autoArchivePeriod, "autoArchivePeriod");
  if (autoClosePeriod !== undefined) push("auto_close_period", autoClosePeriod);
  if (autoArchivePeriod !== undefined) push("auto_archive_period", autoArchivePeriod);
  if (input.autoCloseStateId !== undefined) {
    if (input.autoCloseStateId === null) {
      push("auto_close_state_id", null);
    } else {
      const state = db
        .query("SELECT id, type, is_reserved FROM workflow_states WHERE id = ?1 AND team_id = ?2")
        .get(input.autoCloseStateId, team.id) as {
        id: string;
        type: string;
        is_reserved: number | boolean;
      } | null;
      if (!state) throw apiError("VALIDATION_FAILED", "Auto-close state must belong to the team");
      if (state.type !== "completed") {
        throw apiError("VALIDATION_FAILED", "Auto-close state must be completed");
      }
      if (Boolean(state.is_reserved)) {
        throw apiError("VALIDATION_FAILED", "Auto-close state cannot be reserved");
      }
      push("auto_close_state_id", state.id);
    }
  }
  if (input.autoCloseParentIssues !== undefined)
    push(
      "auto_close_parent_issues",
      input.autoCloseParentIssues === null ? null : input.autoCloseParentIssues ? 1 : 0,
    );
  if (input.autoCloseChildIssues !== undefined)
    push(
      "auto_close_child_issues",
      input.autoCloseChildIssues === null ? null : input.autoCloseChildIssues ? 1 : 0,
    );
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
  if (sets.length > 0) {
    push("updated_at", now());
    params.push(team.id);
    db.query(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  return getTeam(db, { id })!;
}

const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
const RESERVED_DUPLICATE_STATE_NAME = "Duplicate";

function isReservedState(state: WorkflowStateRow): boolean {
  return Boolean(state.is_reserved);
}

function assertMutableState(state: WorkflowStateRow): void {
  if (isReservedState(state)) {
    throw apiError("VALIDATION_FAILED", "The Duplicate workflow state is managed by the system");
  }
}

/**
 * Borra un estado migrando sus issues a otro (AT-164). `issues.state_id` es NOT
 * NULL: sin destino no hay borrado posible. Se protegen dos invariantes: el team
 * no puede quedarse sin estados, ni sin un estado `completed` (el board necesita
 * uno para cerrar trabajo y el progreso de milestones se calcula con él).
 */
function preserveStateActivityReferences(db: Database, stateId: string, reference: string): void {
  const activities = db
    .query("SELECT id, payload FROM activity WHERE type IN ('state_changed', 'created')")
    .all() as Array<{ id: string; payload: string }>;
  for (const activity of activities) {
    const payload = JSON.parse(activity.payload) as Record<string, unknown>;
    let changed = false;
    for (const field of ["from", "to", "stateId"]) {
      if (payload[field] === stateId) {
        payload[field] = reference;
        changed = true;
      }
    }
    if (changed) {
      db.query("UPDATE activity SET payload = ?1 WHERE id = ?2").run(
        JSON.stringify(payload),
        activity.id,
      );
    }
  }
}

export function deleteWorkflowState(
  db: Database,
  actorId: string,
  id: string,
  moveToStateId?: string | null,
): number {
  const state = db
    .query("SELECT * FROM workflow_states WHERE id = ?1")
    .get(id) as WorkflowStateRow | null;
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");
  if (isReservedState(state)) {
    throw apiError("VALIDATION_FAILED", "The Duplicate workflow state cannot be deleted");
  }
  const automation = db
    .query("SELECT id FROM teams WHERE id = ?1 AND auto_close_state_id = ?2")
    .get(state.team_id, state.id);
  if (automation) {
    throw apiError(
      "VALIDATION_FAILED",
      "The auto-close target state must be cleared before deleting this state",
    );
  }

  const siblings = db
    .query("SELECT * FROM workflow_states WHERE team_id = ?1 AND id != ?2")
    .all(state.team_id, id) as WorkflowStateRow[];
  if (siblings.length === 0) {
    throw apiError("VALIDATION_FAILED", "A team must keep at least one workflow state");
  }
  if (state.type === "completed" && !siblings.some((candidate) => candidate.type === "completed")) {
    throw apiError("VALIDATION_FAILED", "A team must keep at least one completed state");
  }

  const affected = db.query("SELECT count(*) AS n FROM issues WHERE state_id = ?1").get(id) as {
    n: number;
  };

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
    if (isReservedState(target)) {
      throw apiError("VALIDATION_FAILED", "Issues cannot be moved to the reserved Duplicate state");
    }
  }

  const team = db.query("SELECT key FROM teams WHERE id = ?1").get(state.team_id) as {
    key: string;
  };
  const historicalReference = `${team.key}/${state.name}`;
  db.transaction(() => {
    if (target) {
      const issues = db
        .query("SELECT id, workspace_id FROM issues WHERE state_id = ?1")
        .all(id) as Array<{ id: string; workspace_id?: string | null }>;
      db.query("UPDATE issues SET state_id = ?1, updated_at = ?2 WHERE state_id = ?3").run(
        target.id,
        now(),
        id,
      );
      // Cada migración queda en el historial, como cualquier cambio de estado.
      for (const issue of issues) {
        recordActivity(
          db,
          issue.id,
          actorId,
          "state_changed",
          { from: id, to: target.id, reason: "state_deleted" },
          undefined,
          issue.workspace_id ?? undefined,
        );
      }
    }
    // Si se borra el estado default, se reasigna: al destino de la migración o
    // al de menor posición restante (AT-180).
    const team = db
      .query("SELECT default_state_id FROM teams WHERE id = ?1")
      .get(state.team_id) as { default_state_id: string | null } | null;
    if (team?.default_state_id === id) {
      const fallback = target ?? [...siblings].sort((a, b) => a.position - b.position)[0]!;
      db.query("UPDATE teams SET default_state_id = ?1 WHERE id = ?2").run(
        fallback.id,
        state.team_id,
      );
    }
    // Keep historical events readable after the row disappears. The
    // qualified key prevents a state with the same name in another team from
    // being selected during a later rebuild.
    preserveStateActivityReferences(db, id, historicalReference);
    db.query("DELETE FROM workflow_states WHERE id = ?1").run(id);
  })();

  return affected.n;
}

export function updateWorkflowState(
  db: Database,
  id: string,
  input: {
    name?: string | null;
    type?: string | null;
    color?: string | null;
    position?: number | null;
    description?: string | null;
  },
): WorkflowStateRow {
  const state = db
    .query("SELECT * FROM workflow_states WHERE id = ?1")
    .get(id) as WorkflowStateRow | null;
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");
  if (
    isReservedState(state) &&
    Object.keys(input).some((key) => input[key as keyof typeof input] !== undefined)
  ) {
    assertMutableState(state);
  }
  if (input.type != null && !STATE_TYPES.includes(input.type)) {
    throw apiError("VALIDATION_FAILED", `Invalid state type: ${input.type}`);
  }
  if (input.type != null && input.type !== state.type && state.type === "completed") {
    const configured = db
      .query("SELECT id FROM teams WHERE id = ?1 AND auto_close_state_id = ?2")
      .get(state.team_id, state.id);
    if (configured) {
      throw apiError(
        "VALIDATION_FAILED",
        "The auto-close target state must remain completed or be cleared first",
      );
    }
    const remainingCompleted = db
      .query(
        "SELECT count(*) AS n FROM workflow_states WHERE team_id = ?1 AND type = 'completed' AND id != ?2",
      )
      .get(state.team_id, id) as { n: number };
    if (remainingCompleted.n === 0) {
      throw apiError("VALIDATION_FAILED", "A team must keep at least one completed state");
    }
  }
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "State name cannot be empty");
    if (name.toLowerCase() === RESERVED_DUPLICATE_STATE_NAME.toLowerCase()) {
      throw apiError("VALIDATION_FAILED", "Duplicate is a reserved workflow state name");
    }
    const duplicate = db
      .query(
        "SELECT id FROM workflow_states WHERE team_id = ?1 AND lower(name) = lower(?2) AND id != ?3",
      )
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
  if (input.description !== undefined) push("description", input.description?.trim() || null);
  if (sets.length > 0) {
    push("updated_at", now());
    params.push(id);
    db.query(`UPDATE workflow_states SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  return db.query("SELECT * FROM workflow_states WHERE id = ?1").get(id) as WorkflowStateRow;
}

export function createWorkflowState(
  db: Database,
  input: {
    teamId: string;
    name: string;
    type: string;
    color?: string | null;
    position?: number | null;
    description?: string | null;
  },
): WorkflowStateRow {
  const team = getTeam(db, { id: input.teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "State name cannot be empty");
  if (name.toLowerCase() === RESERVED_DUPLICATE_STATE_NAME.toLowerCase()) {
    throw apiError("VALIDATION_FAILED", "Duplicate is a reserved workflow state name");
  }
  if (!STATE_TYPES.includes(input.type)) {
    throw apiError("VALIDATION_FAILED", `Invalid state type: ${input.type}`);
  }
  const duplicate = db
    .query("SELECT id FROM workflow_states WHERE team_id = ?1 AND lower(name) = lower(?2)")
    .get(team.id, name);
  if (duplicate) throw apiError("VALIDATION_FAILED", "State name already exists in this team");

  const maxPosition = db
    .query("SELECT coalesce(max(position), -1) AS max FROM workflow_states WHERE team_id = ?1")
    .get(team.id) as { max: number };
  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO workflow_states
      (id, team_id, name, type, color, position, created_at, updated_at, description, is_reserved)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)`,
  ).run(
    id,
    team.id,
    name,
    input.type,
    input.color ?? "#95a2b3",
    input.position ?? maxPosition.max + 1,
    timestamp,
    timestamp,
    input.description?.trim() || null,
  );
  return db.query("SELECT * FROM workflow_states WHERE id = ?1").get(id) as WorkflowStateRow;
}
