// Ciclos time-boxed por team (PRB-203).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime } from "./datetime.ts";
import { recordActivity } from "./activity.ts";

export type CycleState = "upcoming" | "active" | "completed";

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

function resolveState(state: string): CycleState {
  const normalized = state.toLowerCase() as CycleState;
  if (normalized !== "upcoming" && normalized !== "active" && normalized !== "completed") {
    throw apiError("VALIDATION_FAILED", `Invalid cycle state: ${state}`);
  }
  return normalized;
}

export function createCycle(
  db: Database,
  input: {
    teamId: string;
    name: string;
    startsAt: string;
    endsAt: string;
    state?: string | null;
  },
  workspaceId?: string,
): CycleRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Cycle name cannot be empty");
  const team = workspaceId
    ? db
        .query(`SELECT id FROM teams WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`)
        .get(input.teamId, workspaceId)
    : db.query("SELECT id FROM teams WHERE id = ?1").get(input.teamId);
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const startsAt = parseDateTime(input.startsAt, "Cycle startsAt");
  const endsAt = parseDateTime(input.endsAt, "Cycle endsAt");
  if (startsAt > endsAt) {
    throw apiError("VALIDATION_FAILED", "Cycle startsAt must be before endsAt");
  }
  const state = input.state ? resolveState(input.state) : "upcoming";
  const id = newId();
  const timestamp = now();
  const number = nextNumber(db, input.teamId, workspaceId);
  db.query(
    `INSERT INTO cycles
      (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at, archived_at, workspace_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL, ?9)`,
  ).run(
    id,
    input.teamId,
    number,
    name,
    input.startsAt,
    input.endsAt,
    state,
    timestamp,
    workspaceId ?? null,
  );
  return getCycle(db, id, workspaceId)!;
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
  },
  workspaceId?: string,
): CycleRow {
  const existing = getCycle(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");

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
  if (parseDateTime(startsAt, "Cycle startsAt") > parseDateTime(endsAt, "Cycle endsAt")) {
    throw apiError("VALIDATION_FAILED", "Cycle startsAt must be before endsAt");
  }
  if (input.startsAt != null) push("starts_at", input.startsAt);
  if (input.endsAt != null) push("ends_at", input.endsAt);
  if (input.state != null) push("state", resolveState(input.state));
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
  return getCycle(db, id, workspaceId)!;
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
