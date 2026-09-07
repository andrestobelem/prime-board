import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime } from "./datetime.ts";
import {
  assertCanManagePostgresTeam,
  canDiscoverPostgresTeam,
  getPostgresTeam,
} from "./postgres-teams.ts";
import { mapTeamPlanningSettings, type CycleCadenceSource, type TeamRow } from "./teams.ts";
import {
  addCalendarDays as addCycleCalendarDays,
  cadenceDates as computeCadenceDates,
  type CycleCadenceSettings,
} from "./cycle-cadence.ts";
import type { AutoAddStateType } from "./cycles.ts";
import type { ActorRow } from "../auth/viewer.ts";

export type PostgresCycleState = "upcoming" | "active" | "completed";

export interface PostgresCycleRow {
  id: string;
  team_id: string;
  number: number;
  name: string;
  starts_at: string;
  ends_at: string;
  state: PostgresCycleState;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  cadence_source: CycleCadenceSource;
}

export function mapPostgresCycle(row: PostgresCycleRow) {
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

export async function getPostgresCycle(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresCycleRow | null> {
  return persistence.one<PostgresCycleRow>("SELECT * FROM cycles WHERE id = $1", [id]);
}

export async function listPostgresCycles(
  persistence: Persistence,
  teamId: string,
  includeArchived = false,
): Promise<readonly PostgresCycleRow[]> {
  return persistence.many<PostgresCycleRow>(
    `SELECT * FROM cycles WHERE team_id = $1 ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY number`,
    [teamId],
  );
}

function resolveState(state: string): PostgresCycleState {
  const normalized = state.toLowerCase();
  if (normalized !== "upcoming" && normalized !== "active" && normalized !== "completed") {
    throw apiError("VALIDATION_FAILED", `Invalid cycle state: ${state}`);
  }
  return normalized;
}

function validateDates(startsAt: string, endsAt: string): void {
  if (parseDateTime(startsAt, "Cycle startsAt") > parseDateTime(endsAt, "Cycle endsAt")) {
    throw apiError("VALIDATION_FAILED", "Cycle startsAt must be before endsAt");
  }
}

function assertCyclesEnabled(team: TeamRow): void {
  if (team.cycles_enabled !== true && team.cycles_enabled !== 1) {
    throw apiError("VALIDATION_FAILED", "Cycles are disabled for this Team");
  }
}

function cadenceSettings(team: TeamRow): CycleCadenceSettings {
  const settings = mapTeamPlanningSettings(team);
  return {
    timezone: settings.timezone,
    durationWeeks: settings.cycleDurationWeeks,
    startDay: settings.cycleStartDay,
    cooldownDays: settings.cycleCooldownDays,
  };
}

function cadenceDates(
  team: TeamRow,
  startsAt: string | undefined,
  previousEndsAt: string | undefined,
): { startsAt: string; endsAt: string } {
  return computeCadenceDates(
    cadenceSettings(team),
    new Date().toISOString(),
    startsAt,
    previousEndsAt,
  );
}

async function assertPostgresCycleAccess(
  persistence: Persistence,
  viewer: ActorRow,
  teamId: string,
): Promise<void> {
  await assertCanManagePostgresTeam(persistence, viewer, teamId);
}

async function findCurrentPostgresAutoAddCycle(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
): Promise<PostgresCycleRow | null> {
  const active = await persistence.one<PostgresCycleRow>(
    `SELECT * FROM cycles
     WHERE team_id = $1 AND state = 'active' AND archived_at IS NULL
     ORDER BY number DESC LIMIT 1`,
    [teamId],
  );
  if (active) return active;
  return persistence.one<PostgresCycleRow>(
    `SELECT * FROM cycles
     WHERE team_id = $1 AND state = 'upcoming' AND archived_at IS NULL
     ORDER BY number LIMIT 1`,
    [teamId],
  );
}

async function findNextPostgresUpcomingCycle(
  persistence: Persistence | PersistenceTransaction,
  cycle: PostgresCycleRow,
): Promise<PostgresCycleRow | null> {
  return persistence.one<PostgresCycleRow>(
    `SELECT * FROM cycles
     WHERE team_id = $1 AND number > $2 AND state = 'upcoming' AND archived_at IS NULL
     ORDER BY number LIMIT 1`,
    [cycle.team_id, cycle.number],
  );
}

async function findPreviousPostgresCompletedCycle(
  persistence: Persistence | PersistenceTransaction,
  cycle: PostgresCycleRow,
): Promise<PostgresCycleRow | null> {
  return persistence.one<PostgresCycleRow>(
    `SELECT * FROM cycles
     WHERE team_id = $1 AND number < $2 AND state = 'completed' AND archived_at IS NULL
     ORDER BY number DESC LIMIT 1`,
    [cycle.team_id, cycle.number],
  );
}

function isPostgresCycleCooldown(
  team: TeamRow,
  previous: PostgresCycleRow | null,
  next: PostgresCycleRow,
  referenceAt: number,
): boolean {
  const cooldownDays = Number(team.cycle_cooldown_days ?? 0);
  if (!previous || cooldownDays <= 0) return false;
  const previousEndsAt = parseDateTime(previous.ends_at, "Cycle endsAt");
  const nextStartsAt = parseDateTime(next.starts_at, "Cycle startsAt");
  if (referenceAt < previousEndsAt || referenceAt >= nextStartsAt) return false;
  const configuredEnd = parseDateTime(
    addCycleCalendarDays(previous.ends_at, cooldownDays + 1, team.timezone),
    "Cycle cooldown end",
  );
  return referenceAt < Math.min(nextStartsAt, configuredEnd);
}

/**
 * Selecciona el destino de una Issue sin Cycle para PostgreSQL.
 * Mantiene la misma política que `findAutoAddCycle` en SQLite, incluido el
 * desvío de Started al próximo Cycle durante el cooldown.
 */
export async function findPostgresAutoAddCycle(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
  stateType: AutoAddStateType,
  referenceAt = Date.now(),
): Promise<PostgresCycleRow | null> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) return null;
  if (team.cycles_enabled !== true && team.cycles_enabled !== 1) return null;
  if (team.cycle_auto_add_enabled !== true && team.cycle_auto_add_enabled !== 1) return null;
  const current = await findCurrentPostgresAutoAddCycle(persistence, teamId);
  if (!current) return null;
  const active = current.state === "active" ? current : null;
  const next = active ? await findNextPostgresUpcomingCycle(persistence, active) : null;
  if (stateType !== "completed") {
    if (active && next && isPostgresCycleCooldown(team, active, next, referenceAt)) return next;
    return current;
  }
  if (active && next && isPostgresCycleCooldown(team, active, next, referenceAt)) return active;
  const previous = await findPreviousPostgresCompletedCycle(persistence, current);
  if (isPostgresCycleCooldown(team, previous, current, referenceAt)) return previous;
  return active;
}

async function nextPostgresCycleNumber(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
): Promise<number> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const row = await persistence.one<{ n: number }>(
    "SELECT COALESCE(MAX(number), 0) AS n FROM cycles WHERE team_id = $1",
    [teamId],
  );
  let highest = Number(row?.n ?? 0);
  const events = await persistence.many<{ payload: string }>(
    "SELECT payload FROM activity WHERE type = 'cycle_changed'",
  );
  const prefix = `${team.key}/`;
  for (const event of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const value of [payload.from, payload.to]) {
      if (typeof value !== "string" || !value.startsWith(prefix)) continue;
      const number = Number(value.slice(prefix.length));
      if (Number.isInteger(number) && number > highest) highest = number;
    }
  }
  return highest + 1;
}

export async function createPostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  input: {
    teamId: string;
    name: string;
    startsAt?: string | null;
    endsAt?: string | null;
    state?: string | null;
    fromCadence?: boolean | null;
    cadenceSource?: string | null;
  },
): Promise<PostgresCycleRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Cycle name cannot be empty");
  const team = await getPostgresTeam(persistence, { id: input.teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  assertCyclesEnabled(team);
  const requestedCadence = input.fromCadence === true || input.cadenceSource === "cadence";
  if (requestedCadence && input.startsAt == null && input.endsAt != null) {
    throw apiError(
      "VALIDATION_FAILED",
      "Cycle endsAt cannot be supplied without startsAt when fromCadence is enabled",
    );
  }
  const latest =
    requestedCadence && input.endsAt == null
      ? await persistence.one<{ ends_at: string }>(
          "SELECT ends_at FROM cycles WHERE team_id = $1 AND archived_at IS NULL ORDER BY number DESC LIMIT 1",
          [input.teamId],
        )
      : null;
  const generated =
    requestedCadence && input.endsAt == null
      ? cadenceDates(team, input.startsAt ?? undefined, latest?.ends_at)
      : null;
  const cadenceSource: CycleCadenceSource =
    requestedCadence &&
    input.startsAt == null &&
    input.endsAt == null &&
    Number(team.cycle_upcoming_count ?? 0) > 0
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
  validateDates(startsAt, endsAt);
  if (input.cadenceSource && input.cadenceSource !== cadenceSource) {
    throw apiError("VALIDATION_FAILED", "cadenceSource does not match the cycle creation mode");
  }
  await assertPostgresCycleAccess(persistence, viewer, input.teamId);
  const state = input.state ? resolveState(input.state) : "upcoming";
  const id = newId();
  const timestamp = now();
  return persistence.transaction(async (tx) => {
    const lockedTeam = await tx.one<TeamRow>("SELECT * FROM teams WHERE id = $1 FOR UPDATE", [
      input.teamId,
    ]);
    if (!lockedTeam) throw apiError("NOT_FOUND", "Team not found");
    if (state === "active") {
      const active = await tx.one<{ id: string }>(
        "SELECT id FROM cycles WHERE team_id = $1 AND state = 'active' AND archived_at IS NULL LIMIT 1 FOR UPDATE",
        [input.teamId],
      );
      if (active) throw apiError("VALIDATION_FAILED", "A team can have only one active cycle");
    }
    await tx.execute(
      `INSERT INTO cycles
       (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, NULL)`,
      [
        id,
        input.teamId,
        await nextPostgresCycleNumber(tx, input.teamId),
        name,
        startsAt,
        endsAt,
        state,
        cadenceSource,
        timestamp,
      ],
    );
    if (
      (lockedTeam.cycles_enabled === true || lockedTeam.cycles_enabled === 1) &&
      (requestedCadence || state !== "upcoming") &&
      (Number(lockedTeam.cycle_upcoming_count ?? 0) > 0 || state !== "upcoming")
    ) {
      await ensureUpcomingPostgresCadenceCyclesInTransaction(tx, lockedTeam);
    }
    const row = await getPostgresCycle(tx, id);
    if (!row) throw new Error("PostgreSQL cycle insert returned no row");
    if (
      state === "active" &&
      (lockedTeam.cycle_auto_add_enabled === true || lockedTeam.cycle_auto_add_enabled === 1)
    ) {
      await autoAddPostgresActiveIssues(tx, viewer.id, row);
      const updated = await getPostgresCycle(tx, id);
      if (!updated) throw new Error("PostgreSQL cycle insert returned no row");
      return updated;
    }
    return row;
  });
}

export async function createPostgresCycleFromCadence(
  persistence: Persistence,
  viewer: ActorRow,
  input: { teamId: string; name?: string | null; startsAt?: string | null; state?: string | null },
): Promise<PostgresCycleRow> {
  return createPostgresCycle(persistence, viewer, {
    teamId: input.teamId,
    name: input.name?.trim() || "Cycle",
    startsAt: input.startsAt,
    state: input.state,
    fromCadence: true,
  });
}

export async function updatePostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  input: {
    name?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    state?: string | null;
    archived?: boolean | null;
    cadenceSource?: string | null;
  },
): Promise<PostgresCycleRow> {
  const existing = await getPostgresCycle(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
  await assertPostgresCycleAccess(persistence, viewer, existing.team_id);

  return persistence.transaction(async (tx) => {
    // Lock the cycle and Team before deriving validation, dates, and planner
    // effects. This prevents a concurrent update from being applied to stale
    // state and keeps the mutation atomic with horizon maintenance.
    const current = await tx.one<PostgresCycleRow>(
      "SELECT * FROM cycles WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!current) throw apiError("NOT_FOUND", "Cycle not found");
    const team = await tx.one<TeamRow>("SELECT * FROM teams WHERE id = $1 FOR UPDATE", [
      current.team_id,
    ]);
    if (!team) throw apiError("NOT_FOUND", "Team not found");

    if (
      input.cadenceSource != null &&
      input.cadenceSource !== "cadence" &&
      input.cadenceSource !== "manual"
    ) {
      throw apiError("VALIDATION_FAILED", `Invalid cycle cadenceSource: ${input.cadenceSource}`);
    }
    if (input.cadenceSource != null && input.cadenceSource !== current.cadence_source) {
      throw apiError(
        "VALIDATION_FAILED",
        "cycle cadenceSource is read-only; adjust future dates to mark a cycle manual",
      );
    }

    const startsAt = input.startsAt ?? current.starts_at;
    const endsAt = input.endsAt ?? current.ends_at;
    if ((input.startsAt != null || input.endsAt != null) && current.state !== "upcoming") {
      throw apiError("VALIDATION_FAILED", "Only future cycle dates can be adjusted");
    }
    validateDates(startsAt, endsAt);
    const nextState = input.state != null ? resolveState(input.state) : current.state;
    if (nextState === "active" && current.state !== "active") {
      const other = await tx.one<{ id: string }>(
        "SELECT id FROM cycles WHERE team_id = $1 AND id <> $2 AND state = 'active' AND archived_at IS NULL LIMIT 1 FOR UPDATE",
        [current.team_id, id],
      );
      if (other) throw apiError("VALIDATION_FAILED", "A team can have only one active cycle");
    }

    const sets: string[] = [];
    const params: SqlValue[] = [];
    const push = (column: string, value: SqlValue) => {
      sets.push(`${column} = $${params.length + 1}`);
      params.push(value);
    };
    if (input.name !== undefined && input.name !== null) {
      const name = input.name.trim();
      if (!name) throw apiError("VALIDATION_FAILED", "Cycle name cannot be empty");
      push("name", name);
    }
    if (input.startsAt !== undefined && input.startsAt !== null) push("starts_at", input.startsAt);
    if (input.endsAt !== undefined && input.endsAt !== null) push("ends_at", input.endsAt);
    if (input.startsAt != null || input.endsAt != null) push("cadence_source", "manual");
    if (input.state !== undefined && input.state !== null) push("state", nextState);
    if (input.archived === true) push("archived_at", now());
    if (input.archived === false) push("archived_at", null);

    let updated = current;
    if (sets.length) {
      push("updated_at", now());
      params.push(id);
      const row = await tx.one<PostgresCycleRow>(
        `UPDATE cycles SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (!row) throw apiError("NOT_FOUND", "Cycle not found");
      updated = row;
    }
    if (nextState === "completed" && current.state !== "completed") {
      if (team.cycle_rollover_enabled === true || team.cycle_rollover_enabled === 1) {
        const next = await nextPostgresUpcomingCycle(tx, updated.team_id, updated.number);
        if (next) await rolloverPostgresCycleIssues(tx, viewer.id, updated, next);
      }
    }
    if (nextState === "active" && current.state !== "active") {
      if (team.cycle_auto_add_enabled === true || team.cycle_auto_add_enabled === 1) {
        await autoAddPostgresActiveIssues(tx, viewer.id, updated);
      }
    }
    if (
      (team.cycles_enabled === true || team.cycles_enabled === 1) &&
      (current.cadence_source === "cadence" ||
        input.startsAt != null ||
        input.endsAt != null ||
        input.archived != null ||
        input.state != null)
    ) {
      await ensureUpcomingPostgresCadenceCyclesInTransaction(tx, team);
    }
    const result = await getPostgresCycle(tx, id);
    if (!result) throw apiError("NOT_FOUND", "Cycle not found");
    return result;
  });
}

async function nextPostgresUpcomingCycle(
  tx: Persistence | PersistenceTransaction,
  teamId: string,
  number: number,
): Promise<PostgresCycleRow | null> {
  return tx.one<PostgresCycleRow>(
    `SELECT * FROM cycles
     WHERE team_id = $1 AND number > $2 AND state = 'upcoming' AND archived_at IS NULL
     ORDER BY number LIMIT 1`,
    [teamId, number],
  );
}

async function insertPostgresCadenceCycle(
  tx: PersistenceTransaction,
  team: TeamRow,
  previousEndsAt?: string,
  explicitDates?: { startsAt: string; endsAt: string },
): Promise<PostgresCycleRow> {
  const number = await nextPostgresCycleNumber(tx, team.id);
  const dates = explicitDates ?? cadenceDates(team, undefined, previousEndsAt);
  const id = newId();
  const timestamp = now();
  const row = await tx.one<PostgresCycleRow>(
    `INSERT INTO cycles
      (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'upcoming', 'cadence', $7, $7, NULL)
     RETURNING *`,
    [id, team.id, number, `Cycle ${number}`, dates.startsAt, dates.endsAt, timestamp],
  );
  if (!row) throw new Error("PostgreSQL cadence cycle insert returned no row");
  return row;
}

export async function ensureUpcomingPostgresCadenceCyclesInTransaction(
  tx: PersistenceTransaction,
  team: TeamRow,
): Promise<readonly PostgresCycleRow[]> {
  assertCyclesEnabled(team);
  const all = [
    ...(await tx.many<PostgresCycleRow>(
      "SELECT * FROM cycles WHERE team_id = $1 AND archived_at IS NULL",
      [team.id],
    )),
  ];
  const upcoming = all
    .filter((cycle) => cycle.state === "upcoming")
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.number - b.number);
  const manual = upcoming.filter((cycle) => cycle.cadence_source === "manual");
  const cadence = upcoming.filter((cycle) => cycle.cadence_source === "cadence");
  const settingsForCadence = cadenceSettings(team);
  const referenceAt = new Date().toISOString();
  const manualIntervals = manual.map((cycle) => ({
    startsAt: Date.parse(cycle.starts_at),
    endsAt: Date.parse(cycle.ends_at),
  }));
  const overlapsManual = (startsAt: string, endsAt: string): boolean => {
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    return manualIntervals.some((interval) => start < interval.endsAt && end > interval.startsAt);
  };
  const anchor = all
    .filter((cycle) => cycle.state !== "upcoming")
    .sort((a, b) => Date.parse(b.ends_at) - Date.parse(a.ends_at))[0];
  let previousEndsAt = anchor?.ends_at;
  const plannedIntervals: Array<{ startsAt: number; endsAt: number }> = [];
  for (const cycle of [...upcoming]) {
    if (cycle.cadence_source === "manual") {
      if (!previousEndsAt || Date.parse(cycle.ends_at) > Date.parse(previousEndsAt)) {
        previousEndsAt = cycle.ends_at;
      }
      continue;
    }
    let dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, previousEndsAt);
    while (
      overlapsManual(dates.startsAt, dates.endsAt) ||
      plannedIntervals.some((interval) => {
        const start = Date.parse(dates.startsAt);
        const end = Date.parse(dates.endsAt);
        return start < interval.endsAt && end > interval.startsAt;
      })
    ) {
      dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, dates.endsAt);
    }
    if (cycle.starts_at !== dates.startsAt || cycle.ends_at !== dates.endsAt) {
      await tx.execute(
        "UPDATE cycles SET starts_at = $1, ends_at = $2, updated_at = $3 WHERE id = $4",
        [dates.startsAt, dates.endsAt, now(), cycle.id],
      );
      cycle.starts_at = dates.startsAt;
      cycle.ends_at = dates.endsAt;
    }
    plannedIntervals.push({
      startsAt: Date.parse(dates.startsAt),
      endsAt: Date.parse(dates.endsAt),
    });
    previousEndsAt = dates.endsAt;
  }

  const updatedUpcoming = upcoming.sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.number - b.number,
  );
  const updatedCadence = updatedUpcoming.filter((cycle) => cycle.cadence_source === "cadence");
  const settings = mapTeamPlanningSettings(team);
  const keepCadence = Math.max(0, settings.cycleUpcomingCount - manual.length);
  const timestamp = now();
  for (const cycle of updatedCadence.slice(keepCadence)) {
    await tx.execute("UPDATE cycles SET archived_at = $1, updated_at = $1 WHERE id = $2", [
      timestamp,
      cycle.id,
    ]);
  }
  const kept = updatedCadence.slice(0, keepCadence);
  previousEndsAt = [...all]
    .filter((cycle) => cycle.state !== "upcoming" || cycle.cadence_source === "manual")
    .sort((a, b) => Date.parse(b.ends_at) - Date.parse(a.ends_at))[0]?.ends_at;
  if (!previousEndsAt && kept.length) previousEndsAt = kept[kept.length - 1]!.ends_at;
  const existingStarts = new Set(updatedUpcoming.map((cycle) => Date.parse(cycle.starts_at)));
  while (kept.length < keepCadence) {
    let dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, previousEndsAt);
    while (
      existingStarts.has(Date.parse(dates.startsAt)) ||
      overlapsManual(dates.startsAt, dates.endsAt)
    ) {
      dates = computeCadenceDates(settingsForCadence, referenceAt, undefined, dates.endsAt);
    }
    const row = await insertPostgresCadenceCycle(tx, team, previousEndsAt, dates);
    kept.push(row);
    existingStarts.add(Date.parse(row.starts_at));
    previousEndsAt = row.ends_at;
  }
  return tx.many<PostgresCycleRow>(
    "SELECT * FROM cycles WHERE team_id = $1 AND state = 'upcoming' AND archived_at IS NULL ORDER BY number",
    [team.id],
  );
}

export async function ensureUpcomingPostgresCadenceCycles(
  persistence: Persistence,
  teamId: string,
): Promise<readonly PostgresCycleRow[]> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  return persistence.transaction(async (tx) => {
    const locked = await tx.one<{ id: string }>("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [
      team.id,
    ]);
    if (!locked) throw apiError("NOT_FOUND", "Team not found");
    const current = await getPostgresTeam(tx, { id: team.id });
    if (!current) throw apiError("NOT_FOUND", "Team not found");
    return ensureUpcomingPostgresCadenceCyclesInTransaction(tx, current);
  });
}

async function rolloverPostgresCycleIssues(
  tx: PersistenceTransaction,
  actorId: string,
  from: PostgresCycleRow,
  to: PostgresCycleRow,
): Promise<number> {
  const timestamp = now();
  const issues = await tx.many<{ id: string }>(
    `UPDATE issues SET cycle_id = $1, updated_at = $2
     WHERE cycle_id = $3 AND archived_at IS NULL
       AND state_id IN (SELECT id FROM workflow_states WHERE type IN ('unstarted', 'started'))
     RETURNING id`,
    [to.id, timestamp, from.id],
  );
  for (const issue of issues) {
    await recordCycleActivity(
      tx,
      issue.id,
      actorId,
      {
        from: from.id,
        to: to.id,
        reason: "cycle_rollover",
      },
      timestamp,
    );
  }
  return issues.length;
}

async function autoAddPostgresIssuesToCycle(
  tx: PersistenceTransaction,
  actorId: string,
  cycle: PostgresCycleRow,
  stateTypes: readonly AutoAddStateType[],
): Promise<number> {
  if (!stateTypes.length) return 0;
  const stateFilter = stateTypes.map((state) => `'${state}'`).join(", ");
  const timestamp = now();
  const issues = await tx.many<{ id: string }>(
    `UPDATE issues SET cycle_id = $1, updated_at = $2
     WHERE team_id = $3 AND cycle_id IS NULL AND archived_at IS NULL
       AND state_id IN (
         SELECT id FROM workflow_states WHERE team_id = $3 AND type IN (${stateFilter})
       )
     RETURNING id`,
    [cycle.id, timestamp, cycle.team_id],
  );
  for (const issue of issues) {
    await recordCycleActivity(
      tx,
      issue.id,
      actorId,
      {
        from: null,
        to: cycle.id,
        reason: "cycle_auto_add",
      },
      timestamp,
    );
  }
  return issues.length;
}

/**
 * Asigna una Issue sin Cycle al destino que corresponde a su estado.
 * La condición `cycle_id IS NULL` hace que los reintentos sean idempotentes.
 */
export async function autoAddPostgresIssue(
  persistence: Persistence | PersistenceTransaction,
  actorId: string,
  issueId: string,
  stateType: AutoAddStateType,
  referenceAt = Date.now(),
): Promise<boolean> {
  const issue = await persistence.one<{
    id: string;
    team_id: string;
    state_id: string;
    cycle_id: string | null;
    archived_at: string | null;
    state_type: AutoAddStateType;
  }>(
    `SELECT issues.id, issues.team_id, issues.state_id, issues.cycle_id,
            issues.archived_at, workflow_states.type AS state_type
     FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
     WHERE issues.id = $1`,
    [issueId],
  );
  if (!issue || issue.cycle_id !== null || issue.archived_at !== null) return false;
  if (issue.state_type !== stateType) return false;
  const target = await findPostgresAutoAddCycle(persistence, issue.team_id, stateType, referenceAt);
  if (!target) return false;
  const updated = await persistence.one<{ id: string }>(
    `UPDATE issues SET cycle_id = $1, updated_at = $2
     WHERE id = $3 AND cycle_id IS NULL AND archived_at IS NULL AND state_id = $4
     RETURNING id`,
    [target.id, now(), issue.id, issue.state_id],
  );
  if (!updated) return false;
  await recordCycleActivity(
    persistence,
    issue.id,
    actorId,
    { from: null, to: target.id, reason: "cycle_auto_add" },
    now(),
  );
  return true;
}

/**
 * Agrega las Issues activas al Cycle recién activado.
 * Las Issues Completed se dirigen al Cycle anterior durante el cooldown.
 */
export async function autoAddPostgresActiveIssues(
  tx: PersistenceTransaction,
  actorId: string,
  cycle: PostgresCycleRow,
  referenceAt = Date.now(),
): Promise<number> {
  const activeCount = await autoAddPostgresIssuesToCycle(tx, actorId, cycle, [
    "unstarted",
    "started",
  ]);
  const completedTarget = await findPostgresAutoAddCycle(
    tx,
    cycle.team_id,
    "completed",
    referenceAt,
  );
  const completedCount = completedTarget
    ? await autoAddPostgresIssuesToCycle(tx, actorId, completedTarget, ["completed"])
    : 0;
  return activeCount + completedCount;
}

export async function advancePostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
): Promise<{ cycle: PostgresCycleRow; nextCycle: PostgresCycleRow | null; movedIssues: number }> {
  const existing = await getPostgresCycle(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
  await assertPostgresCycleAccess(persistence, viewer, existing.team_id);
  const result = await persistence.transaction(async (tx) => {
    const current = await tx.one<PostgresCycleRow>(
      "SELECT * FROM cycles WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!current) throw apiError("NOT_FOUND", "Cycle not found");
    const team = await tx.one<TeamRow>("SELECT * FROM teams WHERE id = $1 FOR UPDATE", [
      current.team_id,
    ]);
    if (!team) throw apiError("NOT_FOUND", "Team not found");
    assertCyclesEnabled(team);
    const active = await tx.one<PostgresCycleRow>(
      `SELECT * FROM cycles
       WHERE team_id = $1 AND state = 'active' AND archived_at IS NULL AND id <> $2
       ORDER BY number DESC LIMIT 1 FOR UPDATE`,
      [current.team_id, id],
    );
    let target: PostgresCycleRow | null = current;
    let movedIssues = 0;
    if (current.state === "active") {
      await tx.execute("UPDATE cycles SET state = 'completed', updated_at = $1 WHERE id = $2", [
        now(),
        current.id,
      ]);
      target = await nextPostgresUpcomingCycle(tx, current.team_id, current.number);
      if (!target) target = await insertPostgresCadenceCycle(tx, team, current.ends_at);
      if (team.cycle_rollover_enabled === true || team.cycle_rollover_enabled === 1) {
        movedIssues = await rolloverPostgresCycleIssues(tx, viewer.id, current, target);
      }
    } else if (current.state === "upcoming") {
      if (active) {
        await tx.execute("UPDATE cycles SET state = 'completed', updated_at = $1 WHERE id = $2", [
          now(),
          active.id,
        ]);
        if (team.cycle_rollover_enabled === true || team.cycle_rollover_enabled === 1) {
          movedIssues = await rolloverPostgresCycleIssues(tx, viewer.id, active, current);
        }
      }
    } else {
      throw apiError("VALIDATION_FAILED", "Completed cycles cannot be advanced");
    }
    if (!target) throw new Error("Cycle advance did not select a target");
    const promoted = await tx.one<PostgresCycleRow>(
      "UPDATE cycles SET state = 'active', updated_at = $1 WHERE id = $2 RETURNING *",
      [now(), target.id],
    );
    if (!promoted) throw apiError("NOT_FOUND", "Cycle not found");
    if (team.cycle_auto_add_enabled === true || team.cycle_auto_add_enabled === 1) {
      movedIssues += await autoAddPostgresActiveIssues(tx, viewer.id, promoted);
    }
    await ensureUpcomingPostgresCadenceCyclesInTransaction(tx, team);
    const nextCycle = await nextPostgresUpcomingCycle(tx, team.id, promoted.number);
    return { cycle: promoted, nextCycle, movedIssues };
  });
  return result;
}

async function preserveCycleActivityReferences(
  tx: PersistenceTransaction,
  cycleId: string,
  reference: string,
): Promise<void> {
  const activities = await tx.many<{ id: string; payload: string }>(
    "SELECT id, payload FROM activity WHERE type = 'cycle_changed'",
  );
  for (const activity of activities) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(activity.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    let changed = false;
    for (const field of ["from", "to"]) {
      if (payload[field] === cycleId) {
        payload[field] = reference;
        changed = true;
      }
    }
    if (changed) {
      await tx.execute("UPDATE activity SET payload = $1 WHERE id = $2", [
        JSON.stringify(payload),
        activity.id,
      ]);
    }
  }
}

async function recordCycleActivity(
  tx: Persistence | PersistenceTransaction,
  issueId: string,
  actorId: string,
  payload: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  await tx.execute(
    `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
     VALUES ($1, $2, $3, 'cycle_changed', $4, $5)`,
    [newId(), issueId, actorId, JSON.stringify(payload), createdAt],
  );
}

export async function deletePostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
): Promise<boolean> {
  const existing = await getPostgresCycle(persistence, id);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
  await assertPostgresCycleAccess(persistence, viewer, existing.team_id);
  const team = await getPostgresTeam(persistence, { id: existing.team_id });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const reference = `${team.key}/${existing.number}`;
  const cadenceBeforeDelete = await persistence.one<{ count: number }>(
    "SELECT count(*)::int AS count FROM cycles WHERE team_id = $1 AND state = 'upcoming' AND cadence_source = 'cadence' AND archived_at IS NULL",
    [existing.team_id],
  );
  await persistence.transaction(async (tx) => {
    await preserveCycleActivityReferences(tx, id, reference);
    const timestamp = now();
    const issues = await tx.many<{ id: string }>(
      `UPDATE issues SET cycle_id = NULL, updated_at = $1
       WHERE cycle_id = $2
       RETURNING id`,
      [timestamp, id],
    );
    for (const issue of issues) {
      await recordCycleActivity(tx, issue.id, viewer.id, { from: reference, to: null }, timestamp);
    }

    await tx.execute("DELETE FROM cycles WHERE id = $1", [id]);
    const locked = await tx.one<{ id: string }>("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [
      existing.team_id,
    ]);
    if (!locked) throw apiError("NOT_FOUND", "Team not found");
    const currentTeam = await getPostgresTeam(tx, { id: existing.team_id });
    if (
      (existing.cadence_source === "cadence" || Number(cadenceBeforeDelete?.count ?? 0) > 0) &&
      currentTeam &&
      (currentTeam.cycles_enabled === true || currentTeam.cycles_enabled === 1)
    ) {
      await ensureUpcomingPostgresCadenceCyclesInTransaction(tx, currentTeam);
    }
  });
  return true;
}

export async function cycleProgress(
  persistence: Persistence,
  cycleId: string,
): Promise<{ totalIssues: number; completedIssues: number; progress: number }> {
  const row = await persistence.one<{ total: number; done: number | null }>(
    `SELECT count(*)::int AS total,
            COALESCE(sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0)::int AS done
     FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
     WHERE issues.cycle_id = $1 AND issues.archived_at IS NULL`,
    [cycleId],
  );
  const totalIssues = Number(row?.total ?? 0);
  const completedIssues = Number(row?.done ?? 0);
  return {
    totalIssues,
    completedIssues,
    progress: totalIssues === 0 ? 0 : completedIssues / totalIssues,
  };
}

export async function carryOverPostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  fromCycleId: string,
  toCycleId: string,
): Promise<number> {
  const from = await getPostgresCycle(persistence, fromCycleId);
  const to = await getPostgresCycle(persistence, toCycleId);
  if (!from || !to) throw apiError("NOT_FOUND", "Cycle not found");
  if (from.team_id !== to.team_id) {
    throw apiError("VALIDATION_FAILED", "Carry-over requires cycles of the same team");
  }
  await assertPostgresCycleAccess(persistence, viewer, from.team_id);
  let affected: readonly { id: string }[] = [];
  await persistence.transaction(async (tx) => {
    const timestamp = now();
    affected = await tx.many<{ id: string }>(
      `UPDATE issues SET cycle_id = $2, updated_at = $3
       WHERE cycle_id = $1 AND archived_at IS NULL
         AND state_id IN (SELECT id FROM workflow_states WHERE type NOT IN ('completed', 'canceled'))
       RETURNING id`,
      [fromCycleId, toCycleId, timestamp],
    );
    for (const issue of affected) {
      await recordCycleActivity(
        tx,
        issue.id,
        viewer.id,
        { from: fromCycleId, to: toCycleId },
        timestamp,
      );
    }
  });
  return affected.length;
}

export async function validatePostgresCycleForTeam(
  persistence: Persistence | PersistenceTransaction,
  cycleId: string,
  teamId: string,
): Promise<void> {
  const cycle = await getPostgresCycle(persistence, cycleId);
  if (!cycle) throw apiError("NOT_FOUND", "Cycle not found");
  if (cycle.team_id !== teamId) {
    throw apiError("VALIDATION_FAILED", "Cycle belongs to a different team");
  }
}

export async function canAccessPostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  cycleId: string,
): Promise<boolean> {
  const cycle = await getPostgresCycle(persistence, cycleId);
  const team = cycle ? await getPostgresTeam(persistence, { id: cycle.team_id }) : null;
  return Boolean(team && (await canDiscoverPostgresTeam(persistence, viewer, team)));
}
