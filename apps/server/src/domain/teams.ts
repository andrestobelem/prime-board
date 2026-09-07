// Dominio de teams: creación (con workflow default), lookup y mapeos.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { seedTeamWorkflow } from "../db/seed.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";

export type EstimateScale = "exponential" | "fibonacci" | "linear" | "t_shirt";
export type CycleStartDay =
  "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
export type CycleCadenceSource = "cadence" | "manual";

/** SQLite returns 0/1 while PostgreSQL returns booleans for these columns. */
type DatabaseBoolean = boolean | number;

export interface TeamRow {
  id: string;
  workspace_id: string | null;
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
  timezone: string;
  estimates_enabled: DatabaseBoolean;
  estimate_scale: EstimateScale;
  estimate_extended_scale: DatabaseBoolean;
  estimate_allow_zero: DatabaseBoolean;
  cycles_enabled: DatabaseBoolean;
  cycle_duration_weeks: number;
  cycle_start_day: number;
  cycle_cooldown_days: number;
  cycle_upcoming_count: number;
  cycle_rollover_enabled: DatabaseBoolean;
  cycle_auto_add_enabled: DatabaseBoolean;
}

const CYCLE_START_DAYS: readonly CycleStartDay[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const ESTIMATE_SCALES: readonly EstimateScale[] = ["exponential", "fibonacci", "linear", "t_shirt"];

function toBoolean(value: DatabaseBoolean): boolean {
  return value === true || value === 1;
}

function cycleStartDayName(value: number): CycleStartDay {
  return CYCLE_START_DAYS[value - 1] ?? "monday";
}

function cycleStartDayNumber(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const index = CYCLE_START_DAYS.indexOf(normalized as CycleStartDay);
    if (index >= 0) return index + 1;
  }
  throw apiError("VALIDATION_FAILED", "cycleStartDay must be a weekday from monday to sunday");
}

function validateTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone) throw apiError("VALIDATION_FAILED", "Team timezone cannot be empty");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw apiError("VALIDATION_FAILED", `Invalid Team timezone: ${timezone}`);
  }
  return timezone;
}

export interface TeamPlanningSettings {
  timezone: string;
  estimatesEnabled: boolean;
  estimateScale: EstimateScale;
  estimateExtendedScale: boolean;
  estimateAllowZero: boolean;
  cyclesEnabled: boolean;
  cycleDurationWeeks: number;
  cycleStartDay: CycleStartDay;
  cycleCooldownDays: number;
  cycleUpcomingCount: number;
  cycleRolloverEnabled: boolean;
  cycleAutoAddEnabled: boolean;
}

export function mapTeamPlanningSettings(row: TeamRow): TeamPlanningSettings {
  return {
    timezone: row.timezone,
    estimatesEnabled: toBoolean(row.estimates_enabled),
    estimateScale: row.estimate_scale,
    estimateExtendedScale: toBoolean(row.estimate_extended_scale),
    estimateAllowZero: toBoolean(row.estimate_allow_zero),
    cyclesEnabled: toBoolean(row.cycles_enabled),
    cycleDurationWeeks: row.cycle_duration_weeks,
    cycleStartDay: cycleStartDayName(row.cycle_start_day),
    cycleCooldownDays: row.cycle_cooldown_days,
    cycleUpcomingCount: row.cycle_upcoming_count,
    cycleRolloverEnabled: toBoolean(row.cycle_rollover_enabled),
    cycleAutoAddEnabled: toBoolean(row.cycle_auto_add_enabled),
  };
}

export function estimateScaleValues(
  scale: EstimateScale,
  extended: boolean,
  allowZero = false,
): readonly (number | string)[] {
  const values: Record<EstimateScale, readonly (number | string)[]> = {
    exponential: [1, 2, 4, 8, 16, ...(extended ? [32, 64] : [])],
    fibonacci: [1, 2, 3, 5, 8, ...(extended ? [13, 21] : [])],
    linear: [1, 2, 3, 4, 5, ...(extended ? [6, 7] : [])],
    t_shirt: ["XS", "S", "M", "L", "XL", ...(extended ? ["XXL", "XXXL"] : [])],
  };
  const result = values[scale];
  return allowZero ? [0, ...result] : result;
}

export interface WorkflowStateRow {
  id: string;
  workspace_id: string | null;
  team_id: string;
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
  color: string;
  position: number;
}

export function mapTeam(row: TeamRow) {
  const settings = mapTeamPlanningSettings(row);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    accessPolicy: row.access_policy,
    timezone: settings.timezone,
    estimatesEnabled: settings.estimatesEnabled,
    estimateScale: settings.estimateScale,
    estimateExtendedScale: settings.estimateExtendedScale,
    estimateAllowZero: settings.estimateAllowZero,
    cyclesEnabled: settings.cyclesEnabled,
    cycleDurationWeeks: settings.cycleDurationWeeks,
    cycleStartDay: settings.cycleStartDay,
    cycleCooldownDays: settings.cycleCooldownDays,
    cycleUpcomingCount: settings.cycleUpcomingCount,
    cycleRolloverEnabled: settings.cycleRolloverEnabled,
    cycleAutoAddEnabled: settings.cycleAutoAddEnabled,
    estimateSettings: {
      enabled: settings.estimatesEnabled,
      scale: settings.estimateScale,
      extendedScale: settings.estimateExtendedScale,
      allowZero: settings.estimateAllowZero,
      values: estimateScaleValues(
        settings.estimateScale,
        settings.estimateExtendedScale,
        settings.estimateAllowZero,
      ),
    },
    cycleSettings: {
      enabled: settings.cyclesEnabled,
      durationWeeks: settings.cycleDurationWeeks,
      startDay: settings.cycleStartDay,
      cooldownDays: settings.cycleCooldownDays,
      upcomingCount: settings.cycleUpcomingCount,
      rolloverEnabled: settings.cycleRolloverEnabled,
      autoAddEnabled: settings.cycleAutoAddEnabled,
    },
    createdAt: row.created_at,
    archivedAt: row.archived_at,
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

function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

export function getTeam(
  db: Database,
  ref: { id?: string | null; key?: string | null },
  workspaceId?: string,
): TeamRow | null {
  const where = workspaceId ? ` AND ${workspaceClause("workspace_id", "?2")}` : "";
  if (ref.id) {
    return (
      workspaceId
        ? db.query(`SELECT * FROM teams WHERE id = ?1${where}`).get(ref.id, workspaceId)
        : db.query("SELECT * FROM teams WHERE id = ?1").get(ref.id)
    ) as TeamRow | null;
  }
  if (ref.key) {
    return (
      workspaceId
        ? db
            .query(`SELECT * FROM teams WHERE key = ?1${where}`)
            .get(ref.key.toUpperCase(), workspaceId)
        : db.query("SELECT * FROM teams WHERE key = ?1").get(ref.key.toUpperCase())
    ) as TeamRow | null;
  }
  return null;
}

/** Rechaza mutaciones operativas sobre un Team archivado. */
export function assertTeamActive(db: Database, teamId: string, workspaceId?: string): TeamRow {
  const team = getTeam(db, { id: teamId }, workspaceId);
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
  return team;
}

/** Archiva o restaura un Team sin modificar sus recursos ni identificadores. */
export function archiveTeam(
  db: Database,
  id: string,
  archived: boolean,
  workspaceId?: string,
): TeamRow {
  const team = getTeam(db, { id }, workspaceId);
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (archived && team.archived_at) return team;
  db.query("UPDATE teams SET archived_at = ?1, updated_at = ?2 WHERE id = ?3").run(
    archived ? now() : null,
    now(),
    id,
  );
  return getTeam(db, { id }, workspaceId)!;
}

/**
 * Elimina definitivamente un Team vacío. Los estados y memberships son
 * dependencias internas y se eliminan dentro de la misma transacción; todo
 * recurso que conserva trabajo o referencias externas bloquea la operación.
 */
export function deleteTeam(
  db: Database,
  id: string,
  confirmation: string,
  workspaceId?: string,
): TeamRow {
  const initial = getTeam(db, { id }, workspaceId);
  if (!initial) throw apiError("NOT_FOUND", "Team not found");
  if (confirmation !== initial.key) {
    throw apiError("VALIDATION_FAILED", `Confirmation must exactly match team key ${initial.key}`);
  }

  db.transaction(() => {
    const team = getTeam(db, { id }, workspaceId);
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

export function getWorkflowState(
  db: Database,
  id: string,
  workspaceId?: string,
): WorkflowStateRow | null {
  const query = workspaceId
    ? `SELECT * FROM workflow_states WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM workflow_states WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as WorkflowStateRow | null;
}

export function listTeamStates(
  db: Database,
  teamId: string,
  workspaceId?: string,
): WorkflowStateRow[] {
  const query = workspaceId
    ? `SELECT * FROM workflow_states WHERE team_id = ?1 AND ${workspaceClause("workspace_id", "?2")} ORDER BY position`
    : "SELECT * FROM workflow_states WHERE team_id = ?1 ORDER BY position";
  return (
    workspaceId ? db.query(query).all(teamId, workspaceId) : db.query(query).all(teamId)
  ) as WorkflowStateRow[];
}

export interface TeamPlanningSettingsInput {
  timezone?: string | null;
  estimatesEnabled?: boolean | null;
  estimateScale?: string | null;
  estimateExtendedScale?: boolean | null;
  estimateExtended?: boolean | null;
  estimateAllowZero?: boolean | null;
  estimateZero?: boolean | null;
  cyclesEnabled?: boolean | null;
  cycleDurationWeeks?: number | null;
  cycleDuration?: number | null;
  cycleStartDay?: string | number | null;
  cycleCooldownDays?: number | null;
  cycleCooldown?: number | null;
  cycleUpcomingCount?: number | null;
  upcomingCycles?: number | null;
  cycleRolloverEnabled?: boolean | null;
  cycleRollover?: boolean | null;
  cycleAutoAddEnabled?: boolean | null;
  cycleAutoAdd?: boolean | null;
}

export interface NormalizedPlanningSettings {
  timezone: string;
  estimatesEnabled: boolean;
  estimateScale: EstimateScale;
  estimateExtendedScale: boolean;
  estimateAllowZero: boolean;
  cyclesEnabled: boolean;
  cycleDurationWeeks: number;
  cycleStartDay: number;
  cycleCooldownDays: number;
  cycleUpcomingCount: number;
  cycleRolloverEnabled: boolean;
  cycleAutoAddEnabled: boolean;
}

function chooseSetting<T>(field: string, values: readonly (T | null | undefined)[]): T | undefined {
  let found: T | undefined;
  let hasValue = false;
  for (const value of values) {
    if (value == null) continue;
    if (hasValue && value !== found) {
      throw apiError("VALIDATION_FAILED", `${field} aliases must have the same value`);
    }
    found = value;
    hasValue = true;
  }
  return found;
}

function booleanSetting(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw apiError("VALIDATION_FAILED", `${field} must be a boolean`);
  }
  return value;
}

function scaleSetting(value: unknown): EstimateScale {
  if (typeof value !== "string") {
    throw apiError("VALIDATION_FAILED", "estimateScale is invalid");
  }
  const scale = ESTIMATE_SCALES.find((candidate) => candidate === value.trim().toLowerCase());
  if (!scale) throw apiError("VALIDATION_FAILED", `Invalid estimate scale: ${value}`);
  return scale;
}

function integerSetting(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw apiError(
      "VALIDATION_FAILED",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function normalizePlanningSettings(
  input: TeamPlanningSettingsInput,
  current?: TeamRow,
): NormalizedPlanningSettings {
  const existing = current ? mapTeamPlanningSettings(current) : null;
  const timezone = chooseSetting("timezone", [input.timezone]);
  const estimatesEnabled = chooseSetting("estimatesEnabled", [input.estimatesEnabled]);
  const estimateScale = chooseSetting("estimateScale", [input.estimateScale]);
  const estimateExtendedScale = chooseSetting("estimateExtendedScale", [
    input.estimateExtendedScale,
    input.estimateExtended,
  ]);
  const estimateAllowZero = chooseSetting("estimateAllowZero", [
    input.estimateAllowZero,
    input.estimateZero,
  ]);
  const cyclesEnabled = chooseSetting("cyclesEnabled", [input.cyclesEnabled]);
  const cycleDurationWeeks = chooseSetting("cycleDurationWeeks", [
    input.cycleDurationWeeks,
    input.cycleDuration,
  ]);
  const cycleStartDay = chooseSetting("cycleStartDay", [input.cycleStartDay]);
  const cycleCooldownDays = chooseSetting("cycleCooldownDays", [
    input.cycleCooldownDays,
    input.cycleCooldown,
  ]);
  const cycleUpcomingCount = chooseSetting("cycleUpcomingCount", [
    input.cycleUpcomingCount,
    input.upcomingCycles,
  ]);
  const cycleRolloverEnabled = chooseSetting("cycleRolloverEnabled", [
    input.cycleRolloverEnabled,
    input.cycleRollover,
  ]);
  const cycleAutoAddEnabled = chooseSetting("cycleAutoAddEnabled", [
    input.cycleAutoAddEnabled,
    input.cycleAutoAdd,
  ]);

  const normalized: NormalizedPlanningSettings = {
    timezone: timezone === undefined ? (existing?.timezone ?? "UTC") : validateTimezone(timezone),
    estimatesEnabled:
      estimatesEnabled === undefined
        ? (existing?.estimatesEnabled ?? false)
        : booleanSetting(estimatesEnabled, "estimatesEnabled"),
    estimateScale:
      estimateScale === undefined
        ? (existing?.estimateScale ?? "fibonacci")
        : scaleSetting(estimateScale),
    estimateExtendedScale:
      estimateExtendedScale === undefined
        ? (existing?.estimateExtendedScale ?? false)
        : booleanSetting(estimateExtendedScale, "estimateExtendedScale"),
    estimateAllowZero:
      estimateAllowZero === undefined
        ? (existing?.estimateAllowZero ?? false)
        : booleanSetting(estimateAllowZero, "estimateAllowZero"),
    cyclesEnabled:
      cyclesEnabled === undefined
        ? (existing?.cyclesEnabled ?? true)
        : booleanSetting(cyclesEnabled, "cyclesEnabled"),
    cycleDurationWeeks:
      cycleDurationWeeks === undefined
        ? (existing?.cycleDurationWeeks ?? 2)
        : integerSetting(cycleDurationWeeks, "cycleDurationWeeks", 1, 8),
    cycleStartDay:
      cycleStartDay === undefined
        ? existing
          ? CYCLE_START_DAYS.indexOf(existing.cycleStartDay) + 1
          : 1
        : cycleStartDayNumber(cycleStartDay),
    cycleCooldownDays:
      cycleCooldownDays === undefined
        ? (existing?.cycleCooldownDays ?? 0)
        : integerSetting(cycleCooldownDays, "cycleCooldownDays", 0, 366),
    cycleUpcomingCount:
      cycleUpcomingCount === undefined
        ? (existing?.cycleUpcomingCount ?? 3)
        : integerSetting(cycleUpcomingCount, "cycleUpcomingCount", 0, 15),
    cycleRolloverEnabled:
      cycleRolloverEnabled === undefined
        ? (existing?.cycleRolloverEnabled ?? true)
        : booleanSetting(cycleRolloverEnabled, "cycleRolloverEnabled"),
    cycleAutoAddEnabled:
      cycleAutoAddEnabled === undefined
        ? (existing?.cycleAutoAddEnabled ?? false)
        : booleanSetting(cycleAutoAddEnabled, "cycleAutoAddEnabled"),
  };
  // Validate the full setting object even when values came from a persisted row.
  if (normalized.timezone !== validateTimezone(normalized.timezone)) {
    throw apiError("VALIDATION_FAILED", "Team timezone is invalid");
  }
  return normalized;
}

export function createTeam(
  db: Database,
  input: {
    name: string;
    key: string;
    description?: string | null;
    visibility?: "public" | "private" | null;
    accessPolicy?: "workspace_members" | "team_members" | null;
  } & TeamPlanningSettingsInput,
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
  const settings = normalizePlanningSettings(input);

  const id = newId();
  db.transaction(() => {
    const timestamp = now();
    db.query(
      `INSERT INTO teams
       (id, workspace_id, name, key, description, visibility, access_policy,
        timezone, estimates_enabled, estimate_scale, estimate_extended_scale, estimate_allow_zero,
        cycles_enabled, cycle_duration_weeks, cycle_start_day, cycle_cooldown_days,
        cycle_upcoming_count, cycle_rollover_enabled, cycle_auto_add_enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)`,
    ).run(
      id,
      workspaceId,
      name,
      key,
      input.description ?? null,
      visibility,
      accessPolicy,
      settings.timezone,
      settings.estimatesEnabled ? 1 : 0,
      settings.estimateScale,
      settings.estimateExtendedScale ? 1 : 0,
      settings.estimateAllowZero ? 1 : 0,
      settings.cyclesEnabled ? 1 : 0,
      settings.cycleDurationWeeks,
      settings.cycleStartDay,
      settings.cycleCooldownDays,
      settings.cycleUpcomingCount,
      settings.cycleRolloverEnabled ? 1 : 0,
      settings.cycleAutoAddEnabled ? 1 : 0,
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
  const workspaceId = team.workspace_id ?? undefined;
  if (team.default_state_id) {
    const state = getWorkflowState(db, team.default_state_id, workspaceId);
    if (state && state.team_id === team.id) return state;
  }
  const states = listTeamStates(db, team.id, workspaceId);
  const state = states[0];
  if (!state) throw apiError("NOT_FOUND", "Team has no workflow states");
  return state;
}

export interface TeamUpdateInput extends TeamPlanningSettingsInput {
  name?: string | null;
  description?: string | null;
  defaultStateId?: string | null;
  visibility?: "public" | "private" | null;
  accessPolicy?: "workspace_members" | "team_members" | null;
}

export function updateTeam(
  db: Database,
  id: string,
  input: TeamUpdateInput,
  workspaceId?: string,
  afterUpdate?: (team: TeamRow) => void,
): TeamRow {
  let updated: TeamRow;
  db.transaction(() => {
    // Derive settings from the row inside the write transaction. This keeps a
    // concurrent Team update from applying a stale alias/default comparison.
    const team = getTeam(db, { id }, workspaceId);
    if (!team) throw apiError("NOT_FOUND", "Team not found");
    const settings = normalizePlanningSettings(input, team);

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
        .query("SELECT id FROM workflow_states WHERE id = ?1 AND team_id = ?2")
        .get(input.defaultStateId, team.id);
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

    const settingColumns: Array<[string, unknown, unknown]> = [
      ["timezone", settings.timezone, team.timezone],
      [
        "estimates_enabled",
        settings.estimatesEnabled ? 1 : 0,
        toBoolean(team.estimates_enabled) ? 1 : 0,
      ],
      ["estimate_scale", settings.estimateScale, team.estimate_scale],
      [
        "estimate_extended_scale",
        settings.estimateExtendedScale ? 1 : 0,
        toBoolean(team.estimate_extended_scale) ? 1 : 0,
      ],
      [
        "estimate_allow_zero",
        settings.estimateAllowZero ? 1 : 0,
        toBoolean(team.estimate_allow_zero) ? 1 : 0,
      ],
      ["cycles_enabled", settings.cyclesEnabled ? 1 : 0, toBoolean(team.cycles_enabled) ? 1 : 0],
      ["cycle_duration_weeks", settings.cycleDurationWeeks, team.cycle_duration_weeks],
      ["cycle_start_day", settings.cycleStartDay, team.cycle_start_day],
      ["cycle_cooldown_days", settings.cycleCooldownDays, team.cycle_cooldown_days],
      ["cycle_upcoming_count", settings.cycleUpcomingCount, team.cycle_upcoming_count],
      [
        "cycle_rollover_enabled",
        settings.cycleRolloverEnabled ? 1 : 0,
        toBoolean(team.cycle_rollover_enabled) ? 1 : 0,
      ],
      [
        "cycle_auto_add_enabled",
        settings.cycleAutoAddEnabled ? 1 : 0,
        toBoolean(team.cycle_auto_add_enabled) ? 1 : 0,
      ],
    ];
    for (const [column, value, previous] of settingColumns) {
      if (value !== previous) push(column, value);
    }

    if (!settings.cyclesEnabled && toBoolean(team.cycles_enabled)) {
      const timestamp = now();
      db.query(
        "UPDATE cycles SET state = 'completed', updated_at = ?1 WHERE team_id = ?2 AND state = 'active'",
      ).run(timestamp, team.id);
      db.query(
        "UPDATE cycles SET archived_at = ?1, updated_at = ?1 WHERE team_id = ?2 AND state = 'upcoming' AND archived_at IS NULL",
      ).run(timestamp, team.id);
    }

    if (sets.length > 0) {
      push("updated_at", now());
      params.push(team.id);
      db.query(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
        ...(params as never[]),
      );
    }
    updated = getTeam(db, { id }, workspaceId)!;
    afterUpdate?.(updated);
  })();
  return updated!;
}

const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

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
  workspaceId?: string,
): number {
  const state = getWorkflowState(db, id, workspaceId);
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
  },
  workspaceId?: string,
): WorkflowStateRow {
  const state = getWorkflowState(db, id, workspaceId);
  if (!state) throw apiError("NOT_FOUND", "Workflow state not found");
  if (input.type != null && !STATE_TYPES.includes(input.type)) {
    throw apiError("VALIDATION_FAILED", `Invalid state type: ${input.type}`);
  }
  if (input.type != null && input.type !== state.type && state.type === "completed") {
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
    db.query(`UPDATE workflow_states SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  const updated = getWorkflowState(db, id, workspaceId);
  if (!updated) throw apiError("NOT_FOUND", "Workflow state not found");
  return updated;
}

export function createWorkflowState(
  db: Database,
  input: {
    teamId: string;
    name: string;
    type: string;
    color?: string | null;
    position?: number | null;
  },
  workspaceId?: string,
): WorkflowStateRow {
  const team = getTeam(db, { id: input.teamId }, workspaceId);
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
    "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  ).run(
    id,
    team.id,
    input.name.trim(),
    input.type,
    input.color ?? "#95a2b3",
    input.position ?? maxPosition.max + 1,
    timestamp,
    timestamp,
    workspaceId ?? team.workspace_id,
  );
  const created = getWorkflowState(db, id, workspaceId);
  if (!created) throw apiError("NOT_FOUND", "Workflow state not found");
  return created;
}
