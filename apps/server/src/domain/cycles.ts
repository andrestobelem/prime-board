// Ciclos time-boxed por team (PRB-203).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

export type CycleState = "upcoming" | "active" | "completed";

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

export function getCycle(db: Database, id: string): CycleRow | null {
  return db.query("SELECT * FROM cycles WHERE id = ?1").get(id) as CycleRow | null;
}

export function listCycles(db: Database, teamId: string, includeArchived = false): CycleRow[] {
  if (includeArchived) {
    return db
      .query("SELECT * FROM cycles WHERE team_id = ?1 ORDER BY number")
      .all(teamId) as CycleRow[];
  }
  return db
    .query("SELECT * FROM cycles WHERE team_id = ?1 AND archived_at IS NULL ORDER BY number")
    .all(teamId) as CycleRow[];
}

function nextNumber(db: Database, teamId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(number), 0) AS n FROM cycles WHERE team_id = ?1")
    .get(teamId) as { n: number };
  return row.n + 1;
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
): CycleRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Cycle name cannot be empty");
  if (!db.query("SELECT id FROM teams WHERE id = ?1").get(input.teamId)) {
    throw apiError("NOT_FOUND", "Team not found");
  }
  if (input.startsAt > input.endsAt) {
    throw apiError("VALIDATION_FAILED", "Cycle startsAt must be before endsAt");
  }
  const state = input.state ? resolveState(input.state) : "upcoming";
  const id = newId();
  const timestamp = now();
  const number = nextNumber(db, input.teamId);
  db.query(
    `INSERT INTO cycles
      (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at, archived_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL)`,
  ).run(id, input.teamId, number, name, input.startsAt, input.endsAt, state, timestamp);
  return getCycle(db, id)!;
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
): CycleRow {
  const existing = getCycle(db, id);
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
  if (startsAt > endsAt) {
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
    db.query(`UPDATE cycles SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  return getCycle(db, id)!;
}

export function deleteCycle(db: Database, id: string): boolean {
  const existing = getCycle(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
  db.query("UPDATE issues SET cycle_id = NULL WHERE cycle_id = ?1").run(id);
  db.query("DELETE FROM cycles WHERE id = ?1").run(id);
  return true;
}

export function cycleProgress(
  db: Database,
  cycleId: string,
): { totalIssues: number; completedIssues: number; progress: number } {
  const row = db
    .query(
      `SELECT count(*) AS total,
              sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
       FROM issues
       JOIN workflow_states ON workflow_states.id = issues.state_id
       WHERE issues.cycle_id = ?1 AND issues.archived_at IS NULL`,
    )
    .get(cycleId) as { total: number; done: number | null };
  const totalIssues = row.total;
  const completedIssues = row.done ?? 0;
  return {
    totalIssues,
    completedIssues,
    progress: totalIssues === 0 ? 0 : completedIssues / totalIssues,
  };
}

/** Mueve issues abiertos del ciclo origen al destino. */
export function carryOverCycle(db: Database, fromCycleId: string, toCycleId: string): number {
  const from = getCycle(db, fromCycleId);
  const to = getCycle(db, toCycleId);
  if (!from || !to) throw apiError("NOT_FOUND", "Cycle not found");
  if (from.team_id !== to.team_id) {
    throw apiError("VALIDATION_FAILED", "Carry-over requires cycles of the same team");
  }
  const result = db
    .query(
      `UPDATE issues SET cycle_id = ?2, updated_at = ?3
       WHERE cycle_id = ?1
         AND archived_at IS NULL
         AND state_id IN (
           SELECT id FROM workflow_states WHERE type NOT IN ('completed', 'canceled')
         )`,
    )
    .run(fromCycleId, toCycleId, now());
  return Number(result.changes);
}

export function validateCycleForTeam(db: Database, cycleId: string, teamId: string): void {
  const cycle = getCycle(db, cycleId);
  if (!cycle) throw apiError("NOT_FOUND", "Cycle not found");
  if (cycle.team_id !== teamId) {
    throw apiError("VALIDATION_FAILED", "Cycle belongs to a different team");
  }
}
