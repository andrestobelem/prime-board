// Ciclos time-boxed por team (PRB-203).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime, parseFutureDateTime } from "./datetime.ts";
import { recordActivity } from "./activity.ts";
import { mapTeamPlanningSettings, type CycleCadenceSource } from "./teams.ts";
import {
  addCalendarDays as addCycleCalendarDays,
  cadenceDates as computeCadenceDates,
  type CycleCadenceSettings,
} from "./cycle-cadence.ts";

export type CycleState = "upcoming" | "active" | "completed";
export type AutoAddStateType = "unstarted" | "started" | "completed";

function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

export interface CycleRow {
  id: string;
  team_id: string;
  number: number;
  name: string;
  starts_at: string;
  ends_at: string;
  state: CycleState;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  cadence_source: CycleCadenceSource;
  workspace_id?: string | null;
}

export function mapCycle(row: CycleRow) {
  return {
    id: row.id,
    teamId: row.team_id,
    number: row.number,
    name: row.name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    state: row.state,
    cadenceSource: row.cadence_source,
    manuallyAdjusted: row.cadence_source === "manual",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function getCycle(db: Database, id: string, workspaceId?: string): CycleRow | null {
  const query = workspaceId
    ? `SELECT * FROM cycles WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM cycles WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as CycleRow | null;
}

export function listCycles(
  db: Database,
  teamId: string,
  includeArchived = false,
  workspaceId?: string,
): CycleRow[] {
  const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?2")}` : "";
  const archived = includeArchived ? "" : " AND archived_at IS NULL";
  const query = `SELECT * FROM cycles WHERE team_id = ?1${workspace}${archived} ORDER BY number`;
  return (
    workspaceId ? db.query(query).all(teamId, workspaceId) : db.query(query).all(teamId)
  ) as CycleRow[];
}

function nextNumber(db: Database, teamId: string, workspaceId?: string): number {
  const team = db.query("SELECT key FROM teams WHERE id = ?1").get(teamId) as { key: string };
  const cycleWhere = workspaceId
    ? `team_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "team_id = ?1";
  const row = db
    .query(`SELECT COALESCE(MAX(number), 0) AS n FROM cycles WHERE ${cycleWhere}`)
    .get(...(workspaceId ? [teamId, workspaceId] : [teamId])) as { n: number };
  let highest = row.n;
  // Deleted cycles leave qualified tombstone references in Activity. Include
  // those numbers in the sequence so a recreated cycle can never silently
  // acquire the identity of an old historical cycle.
  const prefix = `${team.key}/`;
  const events = db
    .query(
      workspaceId
        ? `SELECT payload FROM activity WHERE type = 'cycle_changed' AND ${workspaceClause("workspace_id", "?1")}`
        : "SELECT payload FROM activity WHERE type = 'cycle_changed'",
    )
    .all(...(workspaceId ? [workspaceId] : [])) as Array<{ payload: string }>;
  for (const event of events) {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    for (const value of [payload.from, payload.to]) {
      if (typeof value !== "string" || !value.startsWith(prefix)) continue;
      const number = Number(value.slice(prefix.length));
      if (Number.isInteger(number) && number > highest) highest = number;
    }
  }
  return highest + 1;
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 1;
}

function cadenceSettings(team: import("./teams.ts").TeamRow): CycleCadenceSettings {
  const settings = mapTeamPlanningSettings(team);
  return {
    timezone: settings.timezone,
    durationWeeks: settings.cycleDurationWeeks,
    startDay: settings.cycleStartDay,
    cooldownDays: settings.cycleCooldownDays,
  };
}

function cadenceDates(
  db: Database,
  teamId: string,
  name: string | undefined,
  startsAt: string | undefined,
  workspaceId?: string,
): { name: string | undefined; startsAt: string; endsAt: string } {
  const team = getTeamSettings(db, teamId, workspaceId);
  const settings = cadenceSettings(team);
  const latest = db
    .query(
      `SELECT ends_at FROM cycles WHERE team_id = ?1 AND archived_at IS NULL ${workspaceId ? `AND ${workspaceClause("workspace_id", "?2")}` : ""} ORDER BY number DESC LIMIT 1`,
    )
    .get(...(workspaceId ? [teamId, workspaceId] : [teamId])) as { ends_at: string } | null;
  const dates = computeCadenceDates(settings, new Date().toISOString(), startsAt, latest?.ends_at);
  return { name, ...dates };
}

function getTeamSettings(
  db: Database,
  teamId: string,
  workspaceId?: string,
): import("./teams.ts").TeamRow {
  const query = workspaceId
    ? `SELECT * FROM teams WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM teams WHERE id = ?1";
  const team = (
    workspaceId ? db.query(query).get(teamId, workspaceId) : db.query(query).get(teamId)
  ) as import("./teams.ts").TeamRow | null;
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  return team;
}

function assertCyclesEnabled(team: import("./teams.ts").TeamRow): void {
  if (!databaseBoolean(team.cycles_enabled)) {
    throw apiError("VALIDATION_FAILED", "Cycles are disabled for this Team");
  }
}

function resolveState(state: string): CycleState {
  const normalized = state.toLowerCase() as CycleState;
  if (normalized !== "upcoming" && normalized !== "active" && normalized !== "completed") {
    throw apiError("VALIDATION_FAILED", `Invalid cycle state: ${state}`);
  }
  return normalized;
}

function findCurrentAutoAddCycle(
  db: Database,
  teamId: string,
  workspaceId?: string,
): CycleRow | null {
  const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?2")}` : "";
  const query = `SELECT * FROM cycles
    WHERE team_id = ?1 AND state = 'active' AND archived_at IS NULL${workspace}
    ORDER BY number DESC LIMIT 1`;
  const active = (
    workspaceId ? db.query(query).get(teamId, workspaceId) : db.query(query).get(teamId)
  ) as CycleRow | null;
  if (active) return active;

  const upcomingQuery = `SELECT * FROM cycles
    WHERE team_id = ?1 AND state = 'upcoming' AND archived_at IS NULL${workspace}
    ORDER BY number LIMIT 1`;
  return (
    workspaceId
      ? db.query(upcomingQuery).get(teamId, workspaceId)
      : db.query(upcomingQuery).get(teamId)
  ) as CycleRow | null;
}

function findPreviousCompletedCycle(
  db: Database,
  cycle: CycleRow,
  workspaceId?: string,
): CycleRow | null {
  const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?3")}` : "";
  const query = `SELECT * FROM cycles
    WHERE team_id = ?1 AND number < ?2 AND state = 'completed' AND archived_at IS NULL${workspace}
    ORDER BY number DESC LIMIT 1`;
  return (
    workspaceId
      ? db.query(query).get(cycle.team_id, cycle.number, workspaceId)
      : db.query(query).get(cycle.team_id, cycle.number)
  ) as CycleRow | null;
}

function findNextUpcomingCycle(
  db: Database,
  cycle: CycleRow,
  workspaceId?: string,
): CycleRow | null {
  const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?3")}` : "";
  const query = `SELECT * FROM cycles
    WHERE team_id = ?1 AND number > ?2 AND state = 'upcoming' AND archived_at IS NULL${workspace}
    ORDER BY number LIMIT 1`;
  return (
    workspaceId
      ? db.query(query).get(cycle.team_id, cycle.number, workspaceId)
      : db.query(query).get(cycle.team_id, cycle.number)
  ) as CycleRow | null;
}

function isCycleCooldown(
  team: import("./teams.ts").TeamRow,
  previous: CycleRow | null,
  next: CycleRow,
  referenceAt: number,
): boolean {
  const cooldownDays = Number(team.cycle_cooldown_days ?? 0);
  if (!previous || cooldownDays <= 0) return false;
  const previousEndsAt = parseDateTime(previous.ends_at, "Cycle endsAt");
  const nextStartsAt = parseDateTime(next.starts_at, "Cycle startsAt");
  if (referenceAt < previousEndsAt || referenceAt >= nextStartsAt) return false;
  // The configured cooldown is the upper bound. A manually adjusted cycle can
  // start earlier, but must not extend the cooldown beyond the configured gap.
  const configuredEnd = parseDateTime(
    addCycleCalendarDays(previous.ends_at, cooldownDays + 1, team.timezone),
    "Cycle cooldown end",
  );
  return referenceAt < Math.min(nextStartsAt, configuredEnd);
}

/**
 * Selecciona el Cycle que debe recibir una Issue sin asignar.
 *
 * `unstarted` y `started` usan el Cycle ACTIVE actual, o el próximo UPCOMING
 * cuando el Team todavía está entre Cycles. `completed` usa el Cycle anterior
 * solo durante el cooldown; fuera de ese intervalo usa el Cycle ACTIVE actual.
 * Devuelve null si Cycles o la automatización están deshabilitados.
 */
export function findAutoAddCycle(
  db: Database,
  teamId: string,
  stateType: AutoAddStateType,
  workspaceId?: string,
  referenceAt = Date.now(),
): CycleRow | null {
  const team = getTeamSettings(db, teamId, workspaceId);
  if (!databaseBoolean(team.cycles_enabled) || !databaseBoolean(team.cycle_auto_add_enabled)) {
    return null;
  }
  const current = findCurrentAutoAddCycle(db, teamId, workspaceId);
  if (!current) return null;
  const active = current.state === "active" ? current : null;
  const next = active ? findNextUpcomingCycle(db, active, workspaceId) : null;
  if (stateType !== "completed") {
    // An ACTIVE cycle whose end has passed is still represented as ACTIVE until
    // the next advance. During that gap, Started issues belong to the next
    // UPCOMING cycle instead of the closed cycle.
    if (active && next && isCycleCooldown(team, active, next, referenceAt)) return next;
    return current;
  }

  // In a cooldown after an ACTIVE cycle, Completed issues belong to that
  // closing cycle even before the advance mutation marks it completed.
  if (active && next && isCycleCooldown(team, active, next, referenceAt)) return active;
  const previous = findPreviousCompletedCycle(db, current, workspaceId);
  if (isCycleCooldown(team, previous, current, referenceAt)) return previous;
  return active;
}

function retireCadenceCyclesBeforeActive(
  db: Database,
  teamId: string,
  activeNumber: number,
  workspaceId?: string,
): void {
  const query = workspaceId
    ? `UPDATE cycles SET archived_at = ?1, updated_at = ?1
       WHERE team_id = ?2 AND number < ?3 AND state = 'upcoming'
         AND cadence_source = 'cadence' AND archived_at IS NULL
         AND ${workspaceClause("workspace_id", "?4")}`
    : `UPDATE cycles SET archived_at = ?1, updated_at = ?1
       WHERE team_id = ?2 AND number < ?3 AND state = 'upcoming'
         AND cadence_source = 'cadence' AND archived_at IS NULL`;
  db.query(query).run(
    ...(workspaceId ? [now(), teamId, activeNumber, workspaceId] : [now(), teamId, activeNumber]),
  );
}

export function createCycle(
  db: Database,
  input: {
    teamId: string;
    name: string;
    startsAt?: string | null;
    endsAt?: string | null;
    state?: string | null;
    fromCadence?: boolean | null;
    cadenceSource?: string | null;
  },
  workspaceId?: string,
  actorId?: string,
): CycleRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Cycle name cannot be empty");
  const team = getTeamSettings(db, input.teamId, workspaceId);
  assertCyclesEnabled(team);
  const requestedCadence = input.fromCadence === true || input.cadenceSource === "cadence";
  if (requestedCadence && input.startsAt == null && input.endsAt != null) {
    throw apiError(
      "VALIDATION_FAILED",
      "Cycle endsAt cannot be supplied without startsAt when fromCadence is enabled",
    );
  }
  const generated =
    requestedCadence && input.endsAt == null
      ? cadenceDates(db, input.teamId, input.name, input.startsAt ?? undefined, workspaceId)
      : null;
  // Las fechas explícitas son una modificación deliberada. Conserva la fila
  // como manual para que el planner no la reescriba al cambiar la configuración.
  const cadenceSource: CycleCadenceSource =
    requestedCadence &&
    input.startsAt == null &&
    input.endsAt == null &&
    team.cycle_upcoming_count > 0
      ? "cadence"
      : "manual";
  const startsAt = generated?.startsAt ?? input.startsAt;
  const endsAt = generated?.endsAt ?? input.endsAt;
  if (!startsAt || !endsAt) {
    throw apiError(
      "VALIDATION_FAILED",
      "Cycle startsAt and endsAt are required unless fromCadence is enabled",
    );
  }
  const startsTimestamp = parseDateTime(startsAt, "Cycle startsAt");
  const endsTimestamp = parseDateTime(endsAt, "Cycle endsAt");
  if (startsTimestamp > endsTimestamp) {
    throw apiError("VALIDATION_FAILED", "Cycle startsAt must be before endsAt");
  }
  if (input.cadenceSource && input.cadenceSource !== cadenceSource) {
    throw apiError("VALIDATION_FAILED", "cadenceSource does not match the cycle creation mode");
  }
  const state = input.state ? resolveState(input.state) : "upcoming";
  const id = newId();
  const timestamp = now();
  let result: CycleRow;
  db.transaction(() => {
    if (state === "active") {
      const active = workspaceId
        ? db
            .query(
              `SELECT id FROM cycles
               WHERE team_id = ?1 AND id <> ?2 AND state = 'active' AND archived_at IS NULL
                 AND ${workspaceClause("workspace_id", "?3")}
               LIMIT 1`,
            )
            .get(input.teamId, id, workspaceId)
        : db
            .query(
              `SELECT id FROM cycles
               WHERE team_id = ?1 AND id <> ?2 AND state = 'active' AND archived_at IS NULL
               LIMIT 1`,
            )
            .get(input.teamId, id);
      if (active) throw apiError("VALIDATION_FAILED", "A team can have only one active cycle");
    }
    const number = nextNumber(db, input.teamId, workspaceId);
    db.query(
      `INSERT INTO cycles
        (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, NULL, ?10)`,
    ).run(
      id,
      input.teamId,
      number,
      generated?.name?.trim() || name,
      startsAt,
      endsAt,
      state,
      cadenceSource,
      timestamp,
      workspaceId ?? null,
    );
    if (state === "active") {
      // A direct ACTIVE Cycle is appended after the existing horizon. Retire
      // stale generated rows before replenishing it so advance follows the
      // new Cycle instead of an older sequence number.
      retireCadenceCyclesBeforeActive(db, input.teamId, number, workspaceId);
    }
    if (
      databaseBoolean(team.cycles_enabled) &&
      (requestedCadence || state !== "upcoming") &&
      (team.cycle_upcoming_count > 0 || state !== "upcoming")
    ) {
      ensureUpcomingCadenceCycles(
        db,
        input.teamId,
        workspaceId,
        state === "upcoming" && cadenceSource === "cadence" ? id : undefined,
      );
    }
    result = getCycle(db, id, workspaceId)!;
    if (actorId && state === "active" && databaseBoolean(team.cycle_auto_add_enabled)) {
      autoAddActiveIssues(db, actorId, result, workspaceId);
      result = getCycle(db, id, workspaceId)!;
    }
  })();
  return result!;
}

export function createCycleFromCadence(
  db: Database,
  input: {
    teamId: string;
    name?: string | null;
    startsAt?: string | null;
    state?: string | null;
  },
  workspaceId?: string,
  actorId?: string,
): CycleRow {
  return createCycle(
    db,
    {
      teamId: input.teamId,
      name: input.name?.trim() || "Cycle",
      startsAt: input.startsAt,
      state: input.state,
      fromCadence: true,
    },
    workspaceId,
    actorId,
  );
}

export function updateCycle(
  db: Database,
  id: string,
  input: {
    name?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    state?: string | null;
    archived?: boolean | null;
    cadenceSource?: string | null;
  },
  workspaceId?: string,
  actorId?: string,
): CycleRow {
  let updated: CycleRow;
  db.transaction(() => {
    // Read and validate the cycle inside the write transaction. SQLite does not
    // expose row locks, so this serializes the read/derive/write sequence with
    // concurrent updates instead of applying a stale snapshot.
    const existing = getCycle(db, id, workspaceId);
    if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
    const team = getTeamSettings(db, existing.team_id, workspaceId);
    // Con Cycles deshabilitado no se permiten mutaciones, incluidas las históricas.
    assertCyclesEnabled(team);
    if (
      input.cadenceSource != null &&
      input.cadenceSource !== "cadence" &&
      input.cadenceSource !== "manual"
    ) {
      throw apiError("VALIDATION_FAILED", `Invalid cycle cadenceSource: ${input.cadenceSource}`);
    }
    if (input.cadenceSource != null && input.cadenceSource !== existing.cadence_source) {
      throw apiError(
        "VALIDATION_FAILED",
        "cycle cadenceSource is read-only; adjust future dates to mark a cycle manual",
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      sets.push(`${column} = ?${params.length + 1}`);
      params.push(value);
    };

    if (input.name !== undefined && input.name !== null) {
      const name = input.name.trim();
      if (!name) throw apiError("VALIDATION_FAILED", "Cycle name cannot be empty");
      push("name", name);
    }
    const startsAt = input.startsAt ?? existing.starts_at;
    const endsAt = input.endsAt ?? existing.ends_at;
    const datesChanged = input.startsAt != null || input.endsAt != null;
    if (datesChanged && existing.state !== "upcoming") {
      throw apiError("VALIDATION_FAILED", "Only future cycle dates can be adjusted");
    }
    let startsTimestamp: number;
    let endsTimestamp: number;
    if (datesChanged) {
      const referenceTimestamp = Date.now();
      startsTimestamp = parseFutureDateTime(startsAt, "Cycle startsAt", referenceTimestamp);
      endsTimestamp = parseFutureDateTime(endsAt, "Cycle endsAt", referenceTimestamp);
    } else {
      startsTimestamp = parseDateTime(startsAt, "Cycle startsAt");
      endsTimestamp = parseDateTime(endsAt, "Cycle endsAt");
    }
    if (startsTimestamp > endsTimestamp) {
      throw apiError("VALIDATION_FAILED", "Cycle startsAt must be before endsAt");
    }
    if (input.startsAt != null) push("starts_at", input.startsAt);
    if (input.endsAt != null) push("ends_at", input.endsAt);
    if (input.startsAt != null || input.endsAt != null) push("cadence_source", "manual");
    // cadenceSource is read-only; date edits above mark the cycle as manual.
    const nextState = input.state != null ? resolveState(input.state) : existing.state;
    if (nextState === "active" && existing.state !== "active") {
      const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?3")}` : "";
      const other = workspaceId
        ? db
            .query(
              `SELECT id FROM cycles WHERE team_id = ?1 AND id <> ?2 AND state = 'active' AND archived_at IS NULL${workspace}`,
            )
            .get(team.id, id, workspaceId)
        : db
            .query(
              "SELECT id FROM cycles WHERE team_id = ?1 AND id <> ?2 AND state = 'active' AND archived_at IS NULL",
            )
            .get(team.id, id);
      if (other) throw apiError("VALIDATION_FAILED", "A team can have only one active cycle");
    }
    if (input.state != null) push("state", nextState);
    if (input.archived === true) push("archived_at", now());
    if (input.archived === false) push("archived_at", null);

    if (sets.length > 0) {
      push("updated_at", now());
      params.push(id);
      const workspaceFilter = workspaceId
        ? ` AND ${workspaceClause("workspace_id", `?${params.length + 1}`)}`
        : "";
      if (workspaceId) params.push(workspaceId);
      db.query(
        `UPDATE cycles SET ${sets.join(", ")} WHERE id = ?${params.length - (workspaceId ? 1 : 0)}${workspaceFilter}`,
      ).run(...(params as never[]));
    }
    updated = getCycle(db, id, workspaceId)!;
    if (actorId && nextState === "completed" && existing.state !== "completed") {
      if (databaseBoolean(team.cycle_rollover_enabled)) {
        const next = nextUpcomingCycle(db, updated, workspaceId);
        if (next) rolloverCycleIssues(db, actorId, updated, next, workspaceId);
      }
    }
    if (actorId && nextState === "active" && existing.state !== "active") {
      if (databaseBoolean(team.cycle_auto_add_enabled)) {
        autoAddActiveIssues(db, actorId, updated, workspaceId);
      }
    }
    if (
      databaseBoolean(team.cycles_enabled) &&
      (existing.cadence_source === "cadence" ||
        input.startsAt != null ||
        input.endsAt != null ||
        input.archived != null ||
        input.state != null)
    ) {
      ensureUpcomingCadenceCycles(db, team.id, workspaceId);
    }
    // The planner may rewrite generated dates or archive the row. Return the
    // persisted row after all side effects.
    updated = getCycle(db, id, workspaceId)!;
  })();
  return updated!;
}

function nextUpcomingCycle(db: Database, from: CycleRow, workspaceId?: string): CycleRow | null {
  const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?3")}` : "";
  const query = `SELECT * FROM cycles
    WHERE team_id = ?1 AND number > ?2 AND state = 'upcoming' AND archived_at IS NULL${workspace}
    ORDER BY number LIMIT 1`;
  return (
    workspaceId
      ? db.query(query).get(from.team_id, from.number, workspaceId)
      : db.query(query).get(from.team_id, from.number)
  ) as CycleRow | null;
}

function rolloverCycleIssues(
  db: Database,
  actorId: string,
  from: CycleRow,
  to: CycleRow,
  workspaceId?: string,
): number {
  const workspace = workspaceId ? ` AND ${workspaceClause("issues.workspace_id", "?2")}` : "";
  const rows = db
    .query(
      `SELECT id, workspace_id FROM issues
       WHERE cycle_id = ?1${workspace} AND archived_at IS NULL
         AND state_id IN (SELECT id FROM workflow_states WHERE type IN ('unstarted', 'started'))`,
    )
    .all(...(workspaceId ? [from.id, workspaceId] : [from.id])) as Array<{
    id: string;
    workspace_id?: string | null;
  }>;
  const timestamp = now();
  db.query(
    `UPDATE issues SET cycle_id = ?1, updated_at = ?2
     WHERE cycle_id = ?3${workspaceId ? ` AND ${workspaceClause("workspace_id", "?4")}` : ""}
       AND archived_at IS NULL
       AND state_id IN (SELECT id FROM workflow_states WHERE type IN ('unstarted', 'started'))`,
  ).run(...(workspaceId ? [to.id, timestamp, from.id, workspaceId] : [to.id, timestamp, from.id]));
  for (const issue of rows) {
    recordActivity(
      db,
      issue.id,
      actorId,
      "cycle_changed",
      { from: from.id, to: to.id, reason: "cycle_rollover" },
      undefined,
      issue.workspace_id ?? undefined,
    );
  }
  return rows.length;
}

function autoAddIssuesToCycle(
  db: Database,
  actorId: string,
  cycle: CycleRow,
  stateTypes: readonly AutoAddStateType[],
  workspaceId?: string,
): number {
  if (!stateTypes.length) return 0;
  const stateFilter = stateTypes.map((state) => `'${state}'`).join(", ");
  const workspace = workspaceId ? ` AND ${workspaceClause("issues.workspace_id", "?2")}` : "";
  const rows = db
    .query(
      `SELECT id, workspace_id FROM issues
       WHERE team_id = ?1 AND cycle_id IS NULL${workspace}
         AND archived_at IS NULL
         AND state_id IN (
           SELECT id FROM workflow_states WHERE team_id = ?1 AND type IN (${stateFilter})
         )`,
    )
    .all(...(workspaceId ? [cycle.team_id, workspaceId] : [cycle.team_id])) as Array<{
    id: string;
    workspace_id?: string | null;
  }>;
  const timestamp = now();
  db.query(
    `UPDATE issues SET cycle_id = ?1, updated_at = ?2
     WHERE team_id = ?3 AND cycle_id IS NULL${workspaceId ? ` AND ${workspaceClause("issues.workspace_id", "?4")}` : ""}
       AND archived_at IS NULL
       AND state_id IN (
         SELECT id FROM workflow_states WHERE team_id = ?3 AND type IN (${stateFilter})
       )`,
  ).run(
    ...(workspaceId
      ? [cycle.id, timestamp, cycle.team_id, workspaceId]
      : [cycle.id, timestamp, cycle.team_id]),
  );
  for (const issue of rows) {
    recordActivity(
      db,
      issue.id,
      actorId,
      "cycle_changed",
      { from: null, to: cycle.id, reason: "cycle_auto_add" },
      undefined,
      issue.workspace_id ?? undefined,
    );
  }
  return rows.length;
}

/**
 * Asigna una Issue sin Cycle al destino que corresponde a su estado.
 * La operación es idempotente: solo actualiza filas con `cycle_id IS NULL`.
 * Debe ejecutarse dentro de la transacción de la mutación que crea o cambia
 * la Issue para conservar la Activity con la asignación.
 */
export function autoAddIssue(
  db: Database,
  actorId: string,
  issueId: string,
  stateType: AutoAddStateType,
  workspaceId?: string,
  referenceAt = Date.now(),
): boolean {
  const issueQuery = workspaceId
    ? `SELECT issues.id, issues.team_id, issues.state_id, issues.cycle_id,
              issues.archived_at, issues.workspace_id, workflow_states.type AS state_type
       FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
       WHERE issues.id = ?1 AND issues.workspace_id = ?2`
    : `SELECT issues.id, issues.team_id, issues.state_id, issues.cycle_id,
              issues.archived_at, issues.workspace_id, workflow_states.type AS state_type
       FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
       WHERE issues.id = ?1`;
  const issue = (
    workspaceId ? db.query(issueQuery).get(issueId, workspaceId) : db.query(issueQuery).get(issueId)
  ) as {
    id: string;
    team_id: string;
    state_id: string;
    cycle_id: string | null;
    archived_at: string | null;
    workspace_id?: string | null;
    state_type: AutoAddStateType;
  } | null;
  if (!issue || issue.cycle_id !== null || issue.archived_at !== null) return false;
  if (issue.state_type !== stateType) return false;
  const target = findAutoAddCycle(db, issue.team_id, stateType, workspaceId, referenceAt);
  if (!target) return false;

  const timestamp = now();
  const result = workspaceId
    ? db
        .query(
          `UPDATE issues SET cycle_id = ?1, updated_at = ?2
           WHERE id = ?3 AND workspace_id = ?4 AND cycle_id IS NULL
             AND archived_at IS NULL AND state_id = ?5`,
        )
        .run(target.id, timestamp, issue.id, workspaceId, issue.state_id)
    : db
        .query(
          `UPDATE issues SET cycle_id = ?1, updated_at = ?2
           WHERE id = ?3 AND cycle_id IS NULL AND archived_at IS NULL AND state_id = ?4`,
        )
        .run(target.id, timestamp, issue.id, issue.state_id);
  if (result.changes !== 1) return false;
  recordActivity(
    db,
    issue.id,
    actorId,
    "cycle_changed",
    { from: null, to: target.id, reason: "cycle_auto_add" },
    undefined,
    issue.workspace_id ?? workspaceId,
  );
  return true;
}

/**
 * Agrega las Issues activas al Cycle recién activado.
 * Las Issues Completed se dirigen al Cycle anterior durante el cooldown.
 */
export function autoAddActiveIssues(
  db: Database,
  actorId: string,
  cycle: CycleRow,
  workspaceId?: string,
  referenceAt = Date.now(),
): number {
  // During cooldown, Started issues belong to the next upcoming Cycle.
  // Use the same resolver as issue-level auto-add instead of always using the
  // Cycle that triggered this operation.
  const activeTarget =
    findAutoAddCycle(db, cycle.team_id, "started", workspaceId, referenceAt) ?? cycle;
  const activeCount = autoAddIssuesToCycle(
    db,
    actorId,
    activeTarget,
    ["unstarted", "started"],
    workspaceId,
  );
  const completedTarget = findAutoAddCycle(
    db,
    cycle.team_id,
    "completed",
    workspaceId,
    referenceAt,
  );
  const completedCount = completedTarget
    ? autoAddIssuesToCycle(db, actorId, completedTarget, ["completed"], workspaceId)
    : 0;
  return activeCount + completedCount;
}

/**
 * Mantiene el número configurado de Cycles futuros generados por cadencia.
 * Los Cycles ajustados manualmente nunca se archivan por esta operación.
 */
export function ensureUpcomingCadenceCycles(
  db: Database,
  teamId: string,
  workspaceId?: string,
  preserveCycleId?: string,
): CycleRow[] {
  const team = getTeamSettings(db, teamId, workspaceId);
  assertCyclesEnabled(team);
  const settings = mapTeamPlanningSettings(team);
  const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?2")}` : "";
  const all = (
    workspaceId
      ? db
          .query(`SELECT * FROM cycles WHERE team_id = ?1${workspace} AND archived_at IS NULL`)
          .all(teamId, workspaceId)
      : db.query("SELECT * FROM cycles WHERE team_id = ?1 AND archived_at IS NULL").all(teamId)
  ) as CycleRow[];
  // Cycle numbers define the cadence sequence. A manual date edit must not
  // move a generated Cycle to another sequence position.
  const upcoming = all
    .filter((cycle) => cycle.state === "upcoming")
    .sort(
      (a, b) =>
        a.number - b.number ||
        parseDateTime(a.starts_at, "Cycle startsAt") - parseDateTime(b.starts_at, "Cycle startsAt"),
    );
  const manual = upcoming.filter((cycle) => cycle.cadence_source === "manual");
  const cadence = upcoming.filter((cycle) => cycle.cadence_source === "cadence");
  const settingsForCadence = cadenceSettings(team);
  const referenceAt = new Date().toISOString();
  const manualIntervals = manual.map((cycle) => ({
    startsAt: parseDateTime(cycle.starts_at, "Cycle startsAt"),
    endsAt: parseDateTime(cycle.ends_at, "Cycle endsAt"),
  }));
  const overlapsManual = (startsAt: string, endsAt: string): boolean => {
    const start = parseDateTime(startsAt, "Cycle startsAt");
    const end = parseDateTime(endsAt, "Cycle endsAt");
    return manualIntervals.some((interval) => start < interval.endsAt && end > interval.startsAt);
  };
  const anchor = all
    .filter((cycle) => cycle.state !== "upcoming")
    .sort(
      (a, b) => parseDateTime(b.ends_at, "Cycle endsAt") - parseDateTime(a.ends_at, "Cycle endsAt"),
    )[0];
  let previousEndsAt = anchor?.ends_at;
  const plannedIntervals: Array<{ startsAt: number; endsAt: number }> = [];
  // Recompute unadjusted future cycles from the current Team settings. Manual
  // future cycles remain byte-for-byte unchanged and become the next anchor.
  for (const cycle of [...upcoming]) {
    if (cycle.cadence_source === "manual") {
      if (
        !previousEndsAt ||
        parseDateTime(cycle.ends_at, "Cycle endsAt") > parseDateTime(previousEndsAt, "Cycle endsAt")
      ) {
        previousEndsAt = cycle.ends_at;
      }
      continue;
    }
    let dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, previousEndsAt);
    while (
      overlapsManual(dates.startsAt, dates.endsAt) ||
      plannedIntervals.some((interval) => {
        const start = parseDateTime(dates.startsAt, "Cycle startsAt");
        const end = parseDateTime(dates.endsAt, "Cycle endsAt");
        return start < interval.endsAt && end > interval.startsAt;
      })
    ) {
      dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, dates.endsAt);
    }
    if (cycle.starts_at !== dates.startsAt || cycle.ends_at !== dates.endsAt) {
      const update = workspaceId
        ? `UPDATE cycles SET starts_at = ?1, ends_at = ?2, updated_at = ?3 WHERE id = ?4 AND ${workspaceClause("workspace_id", "?5")}`
        : "UPDATE cycles SET starts_at = ?1, ends_at = ?2, updated_at = ?3 WHERE id = ?4";
      if (workspaceId)
        db.query(update).run(dates.startsAt, dates.endsAt, now(), cycle.id, workspaceId);
      else db.query(update).run(dates.startsAt, dates.endsAt, now(), cycle.id);
      cycle.starts_at = dates.startsAt;
      cycle.ends_at = dates.endsAt;
    }
    plannedIntervals.push({
      startsAt: parseDateTime(dates.startsAt, "Cycle startsAt"),
      endsAt: parseDateTime(dates.endsAt, "Cycle endsAt"),
    });
    previousEndsAt = dates.endsAt;
  }

  const updatedUpcoming = upcoming.sort(
    (a, b) =>
      a.number - b.number ||
      parseDateTime(a.starts_at, "Cycle startsAt") - parseDateTime(b.starts_at, "Cycle startsAt"),
  );
  const updatedCadence = updatedUpcoming.filter((cycle) => cycle.cadence_source === "cadence");
  const keepCadence = Math.max(0, settings.cycleUpcomingCount - manual.length);
  const preserved =
    preserveCycleId && keepCadence > 0
      ? updatedCadence.find((cycle) => cycle.id === preserveCycleId)
      : undefined;
  const candidateSlots = Math.max(0, keepCadence - (preserved ? 1 : 0));
  const candidates = updatedCadence.filter((cycle) => cycle.id !== preserveCycleId);
  const kept = preserved
    ? [...(candidateSlots > 0 ? candidates.slice(-candidateSlots) : []), preserved].sort(
        (a, b) =>
          a.number - b.number ||
          parseDateTime(a.starts_at, "Cycle startsAt") -
            parseDateTime(b.starts_at, "Cycle startsAt"),
      )
    : updatedCadence.slice(0, keepCadence);
  const keptIds = new Set(kept.map((cycle) => cycle.id));
  const timestamp = now();
  for (const cycle of updatedCadence) {
    if (keptIds.has(cycle.id)) continue;
    const query = workspaceId
      ? `UPDATE cycles SET archived_at = ?1, updated_at = ?1 WHERE id = ?2 AND ${workspaceClause("workspace_id", "?3")}`
      : "UPDATE cycles SET archived_at = ?1, updated_at = ?1 WHERE id = ?2";
    if (workspaceId) db.query(query).run(timestamp, cycle.id, workspaceId);
    else db.query(query).run(timestamp, cycle.id);
  }
  // When there is no completed/active anchor, append after the latest existing
  // future boundary. This also handles a manually adjusted final cycle.
  previousEndsAt = [...all]
    .filter((cycle) => cycle.state !== "upcoming" || cycle.cadence_source === "manual")
    .sort(
      (a, b) => parseDateTime(b.ends_at, "Cycle endsAt") - parseDateTime(a.ends_at, "Cycle endsAt"),
    )[0]?.ends_at;
  if (!previousEndsAt && kept.length) previousEndsAt = kept[kept.length - 1]!.ends_at;
  const existingStarts = new Set(
    updatedUpcoming.map((cycle) => parseDateTime(cycle.starts_at, "Cycle startsAt")),
  );
  while (kept.length < keepCadence) {
    let dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, previousEndsAt);
    while (
      existingStarts.has(parseDateTime(dates.startsAt, "Cycle startsAt")) ||
      overlapsManual(dates.startsAt, dates.endsAt)
    ) {
      dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, dates.endsAt);
    }
    const number = nextNumber(db, teamId, workspaceId);
    const id = newId();
    const name = `Cycle ${number}`;
    const query = workspaceId
      ? `INSERT INTO cycles
          (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at, workspace_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'upcoming', 'cadence', ?7, ?7, NULL, ?8)`
      : `INSERT INTO cycles
          (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'upcoming', 'cadence', ?7, ?7, NULL)`;
    if (workspaceId)
      db.query(query).run(
        id,
        teamId,
        number,
        name,
        dates.startsAt,
        dates.endsAt,
        timestamp,
        workspaceId,
      );
    else db.query(query).run(id, teamId, number, name, dates.startsAt, dates.endsAt, timestamp);
    const created = getCycle(db, id, workspaceId);
    if (!created) throw new Error("Cadence cycle insert returned no row");
    kept.push(created);
    existingStarts.add(parseDateTime(dates.startsAt, "Cycle startsAt"));
    previousEndsAt = dates.endsAt;
  }
  return (
    workspaceId
      ? db
          .query(
            `SELECT * FROM cycles WHERE team_id = ?1${workspace} AND state = 'upcoming' AND archived_at IS NULL ORDER BY number`,
          )
          .all(teamId, workspaceId)
      : db
          .query(
            "SELECT * FROM cycles WHERE team_id = ?1 AND state = 'upcoming' AND archived_at IS NULL ORDER BY number",
          )
          .all(teamId)
  ) as CycleRow[];
}

export function advanceCycle(
  db: Database,
  actorId: string,
  id: string,
  workspaceId?: string,
): { cycle: CycleRow; nextCycle: CycleRow | null; movedIssues: number } {
  const initial = getCycle(db, id, workspaceId);
  if (!initial) throw apiError("NOT_FOUND", "Cycle not found");
  let result: { cycle: CycleRow; nextCycle: CycleRow | null; movedIssues: number };
  db.transaction(() => {
    const current = getCycle(db, id, workspaceId);
    if (!current) throw apiError("NOT_FOUND", "Cycle not found");
    const team = getTeamSettings(db, current.team_id, workspaceId);
    assertCyclesEnabled(team);
    let movedIssues = 0;
    let target: CycleRow | null = current;
    const active = (
      workspaceId
        ? db
            .query(
              `SELECT * FROM cycles WHERE team_id = ?1 AND state = 'active' AND archived_at IS NULL AND id <> ?2 AND ${workspaceClause("workspace_id", "?3")} ORDER BY number DESC LIMIT 1`,
            )
            .get(current.team_id, id, workspaceId)
        : db
            .query(
              "SELECT * FROM cycles WHERE team_id = ?1 AND state = 'active' AND archived_at IS NULL AND id <> ?2 ORDER BY number DESC LIMIT 1",
            )
            .get(current.team_id, id)
    ) as CycleRow | null;

    if (current.state === "active") {
      const timestamp = now();
      if (workspaceId) {
        db.query(
          `UPDATE cycles SET state = 'completed', updated_at = ?1 WHERE id = ?2 AND ${workspaceClause("workspace_id", "?3")}`,
        ).run(timestamp, id, workspaceId);
      } else {
        db.query("UPDATE cycles SET state = 'completed', updated_at = ?1 WHERE id = ?2").run(
          timestamp,
          id,
        );
      }
      target = nextUpcomingCycle(db, current, workspaceId);
      if (!target) {
        const dates = cadenceDates(
          db,
          current.team_id,
          `Cycle ${current.number + 1}`,
          undefined,
          workspaceId,
        );
        const targetId = newId();
        const number = nextNumber(db, current.team_id, workspaceId);
        if (workspaceId) {
          db.query(
            `INSERT INTO cycles
              (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at, workspace_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'upcoming', 'cadence', ?7, ?7, NULL, ?8)`,
          ).run(
            targetId,
            current.team_id,
            number,
            dates.name?.trim() || `Cycle ${number}`,
            dates.startsAt,
            dates.endsAt,
            now(),
            workspaceId,
          );
        } else {
          db.query(
            `INSERT INTO cycles
              (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'upcoming', 'cadence', ?7, ?7, NULL)`,
          ).run(
            targetId,
            current.team_id,
            number,
            dates.name?.trim() || `Cycle ${number}`,
            dates.startsAt,
            dates.endsAt,
            now(),
          );
        }
        target = getCycle(db, targetId, workspaceId);
      }
      if (!target) throw new Error("Cycle advance did not create a target");
      if (databaseBoolean(team.cycle_rollover_enabled)) {
        movedIssues = rolloverCycleIssues(db, actorId, current, target, workspaceId);
      }
    } else if (current.state === "upcoming") {
      if (active) {
        const timestamp = now();
        if (workspaceId) {
          db.query(
            `UPDATE cycles SET state = 'completed', updated_at = ?1 WHERE id = ?2 AND ${workspaceClause("workspace_id", "?3")}`,
          ).run(timestamp, active.id, workspaceId);
        } else {
          db.query("UPDATE cycles SET state = 'completed', updated_at = ?1 WHERE id = ?2").run(
            timestamp,
            active.id,
          );
        }
        if (databaseBoolean(team.cycle_rollover_enabled)) {
          movedIssues = rolloverCycleIssues(db, actorId, active, current, workspaceId);
        }
      }
    } else {
      throw apiError("VALIDATION_FAILED", "Completed cycles cannot be advanced");
    }

    if (!target) throw new Error("Cycle advance did not select a target");
    const timestamp = now();
    const workspace = workspaceId ? ` AND ${workspaceClause("workspace_id", "?3")}` : "";
    if (workspaceId) {
      db.query(`UPDATE cycles SET state = 'active', updated_at = ?1 WHERE id = ?2${workspace}`).run(
        timestamp,
        target.id,
        workspaceId,
      );
    } else {
      db.query("UPDATE cycles SET state = 'active', updated_at = ?1 WHERE id = ?2").run(
        timestamp,
        target.id,
      );
    }
    target = getCycle(db, target.id, workspaceId)!;
    if (databaseBoolean(team.cycle_auto_add_enabled)) {
      movedIssues += autoAddActiveIssues(db, actorId, target, workspaceId);
    }
    // Promover un ciclo futuro consume un lugar. Repón el horizonte sin tocar
    // los ciclos ajustados manualmente.
    ensureUpcomingCadenceCycles(db, current.team_id, workspaceId);
    result = { cycle: target, nextCycle: nextUpcomingCycle(db, target, workspaceId), movedIssues };
  })();
  return result!;
}

function cycleReference(db: Database, cycle: CycleRow): string {
  const team = db.query("SELECT key FROM teams WHERE id = ?1").get(cycle.team_id) as {
    key: string;
  };
  return `${team.key}/${cycle.number}`;
}

function preserveCycleActivityReferences(
  db: Database,
  cycleId: string,
  reference: string,
  workspaceId?: string,
): void {
  const query = workspaceId
    ? `SELECT id, payload FROM activity WHERE type = 'cycle_changed' AND ${workspaceClause("workspace_id", "?1")}`
    : "SELECT id, payload FROM activity WHERE type = 'cycle_changed'";
  const activities = db.query(query).all(...(workspaceId ? [workspaceId] : [])) as Array<{
    id: string;
    payload: string;
  }>;
  for (const activity of activities) {
    const payload = JSON.parse(activity.payload) as Record<string, unknown>;
    let changed = false;
    for (const field of ["from", "to"]) {
      if (payload[field] === cycleId) {
        payload[field] = reference;
        changed = true;
      }
    }
    if (changed) {
      if (workspaceId) {
        db.query(
          `UPDATE activity SET payload = ?1 WHERE id = ?2 AND ${workspaceClause("workspace_id", "?3")}`,
        ).run(JSON.stringify(payload), activity.id, workspaceId);
      } else {
        db.query("UPDATE activity SET payload = ?1 WHERE id = ?2").run(
          JSON.stringify(payload),
          activity.id,
        );
      }
    }
  }
}

export function deleteCycle(
  db: Database,
  actorId: string,
  id: string,
  workspaceId?: string,
): boolean {
  const existing = getCycle(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
  const query = workspaceId
    ? `SELECT id, workspace_id FROM issues WHERE cycle_id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT id, workspace_id FROM issues WHERE cycle_id = ?1";
  const affected = db.query(query).all(...(workspaceId ? [id, workspaceId] : [id])) as Array<{
    id: string;
    workspace_id?: string | null;
  }>;
  const reference = cycleReference(db, existing);
  db.transaction(() => {
    // También canoniza eventos anteriores: una vez borrado el cycle, su UUID
    // ya no puede resolverse durante el export.
    preserveCycleActivityReferences(db, id, reference, workspaceId);
    const timestamp = now();
    if (workspaceId) {
      db.query(
        `UPDATE issues SET cycle_id = NULL, updated_at = ?1 WHERE cycle_id = ?2 AND ${workspaceClause("workspace_id", "?3")}`,
      ).run(timestamp, id, workspaceId);
    } else {
      db.query("UPDATE issues SET cycle_id = NULL, updated_at = ?1 WHERE cycle_id = ?2").run(
        timestamp,
        id,
      );
    }
    for (const issue of affected) {
      // El cycle se elimina en esta misma transacción; conservar la clave estable
      // evita que el exportador dependa de una fila que ya no existirá.
      recordActivity(
        db,
        issue.id,
        actorId,
        "cycle_changed",
        { from: reference, to: null },
        undefined,
        issue.workspace_id ?? undefined,
      );
    }
    if (workspaceId) {
      db.query(`DELETE FROM cycles WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`).run(
        id,
        workspaceId,
      );
    } else {
      db.query("DELETE FROM cycles WHERE id = ?1").run(id);
    }
    // Only deleting a non-archived future Cycle consumes a horizon slot.
    // Keep manual Cycles and replenish generated Cycles with the same rule as
    // PostgreSQL.
    if (
      existing.state === "upcoming" &&
      existing.archived_at === null &&
      databaseBoolean(getTeamSettings(db, existing.team_id, workspaceId).cycles_enabled)
    ) {
      ensureUpcomingCadenceCycles(db, existing.team_id, workspaceId);
    }
  })();
  return true;
}

export function cycleProgress(
  db: Database,
  cycleId: string,
  workspaceId?: string,
): { totalIssues: number; completedIssues: number; progress: number } {
  const row = db
    .query(
      `SELECT count(*) AS total,
              sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
       FROM issues
       JOIN workflow_states ON workflow_states.id = issues.state_id
       WHERE issues.cycle_id = ?1 AND issues.archived_at IS NULL
         ${workspaceId ? `AND ${workspaceClause("issues.workspace_id", "?2")}` : ""}`,
    )
    .get(...(workspaceId ? [cycleId, workspaceId] : [cycleId])) as {
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

/** Mueve issues abiertos del ciclo origen al destino. */
export function carryOverCycle(
  db: Database,
  actorId: string,
  fromCycleId: string,
  toCycleId: string,
  workspaceId?: string,
): number {
  const from = getCycle(db, fromCycleId, workspaceId);
  const to = getCycle(db, toCycleId, workspaceId);
  if (!from || !to) throw apiError("NOT_FOUND", "Cycle not found");
  if (from.team_id !== to.team_id) {
    throw apiError("VALIDATION_FAILED", "Carry-over requires cycles of the same team");
  }
  const affected = db
    .query(
      `SELECT id, workspace_id FROM issues
       WHERE cycle_id = ?1
         ${workspaceId ? `AND ${workspaceClause("workspace_id", "?2")}` : ""}
         AND archived_at IS NULL
         AND state_id IN (
           SELECT id FROM workflow_states WHERE type NOT IN ('completed', 'canceled')
         )`,
    )
    .all(...(workspaceId ? [fromCycleId, workspaceId] : [fromCycleId])) as Array<{
    id: string;
    workspace_id?: string | null;
  }>;
  const timestamp = now();
  db.transaction(() => {
    db.query(
      `UPDATE issues SET cycle_id = ?2, updated_at = ?3
       WHERE cycle_id = ?1
         ${workspaceId ? `AND ${workspaceClause("workspace_id", "?4")}` : ""}
         AND archived_at IS NULL
         AND state_id IN (
           SELECT id FROM workflow_states WHERE type NOT IN ('completed', 'canceled')
         )`,
    ).run(
      ...(workspaceId
        ? [fromCycleId, toCycleId, timestamp, workspaceId]
        : [fromCycleId, toCycleId, timestamp]),
    );
    for (const issue of affected) {
      recordActivity(
        db,
        issue.id,
        actorId,
        "cycle_changed",
        { from: fromCycleId, to: toCycleId },
        undefined,
        issue.workspace_id ?? undefined,
      );
    }
  })();
  return affected.length;
}

export function validateCycleForTeam(
  db: Database,
  cycleId: string,
  teamId: string,
  workspaceId?: string,
): void {
  const cycle = workspaceId
    ? (db
        .query(`SELECT * FROM cycles WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`)
        .get(cycleId, workspaceId) as CycleRow | null)
    : getCycle(db, cycleId);
  if (!cycle) throw apiError("NOT_FOUND", "Cycle not found");
  if (cycle.team_id !== teamId) {
    throw apiError("VALIDATION_FAILED", "Cycle belongs to a different team");
  }
}
