import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { parseDateTime } from "./datetime.ts";
import {
  assertCanManagePostgresTeam,
  canDiscoverPostgresTeam,
  getPostgresTeam,
} from "./postgres-teams.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { PostgresWorkspaceContext } from "./postgres-workspace-scope.ts";
import {
  issueWorkspaceScope,
  scopedWorkspacePredicate,
  workspaceColumnScope,
  workspaceIdOf,
} from "./postgres-workspace-scope.ts";

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export async function getPostgresCycle(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<PostgresCycleRow | null> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => workspaceColumnScope("cycles", workspaceParam),
    "$2",
  );
  return persistence.one<PostgresCycleRow>(
    `SELECT cycles.* FROM cycles WHERE cycles.id = $1 AND ${scope}`,
    [id, ...(context ? [context.workspaceId] : [])],
  );
}

export async function listPostgresCycles(
  persistence: Persistence,
  teamId: string,
  includeArchived = false,
  context?: PostgresWorkspaceContext,
): Promise<readonly PostgresCycleRow[]> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => workspaceColumnScope("cycles", workspaceParam),
    "$2",
  );
  return persistence.many<PostgresCycleRow>(
    `SELECT cycles.* FROM cycles WHERE cycles.team_id = $1 AND ${scope} ${includeArchived ? "" : "AND cycles.archived_at IS NULL"} ORDER BY cycles.number`,
    [teamId, ...(context ? [context.workspaceId] : [])],
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

async function assertPostgresCycleAccess(
  persistence: Persistence,
  viewer: ActorRow,
  teamId: string,
  context?: PostgresWorkspaceContext,
): Promise<void> {
  await assertCanManagePostgresTeam(persistence, viewer, teamId, context);
}

async function nextPostgresCycleNumber(
  persistence: Persistence | PersistenceTransaction,
  teamId: string,
  context?: PostgresWorkspaceContext,
): Promise<number> {
  const team = await getPostgresTeam(persistence, { id: teamId }, context);
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const row = await persistence.one<{ n: number }>(
    context
      ? "SELECT COALESCE(MAX(number), 0) AS n FROM cycles WHERE team_id = $1 AND workspace_id = $2"
      : "SELECT COALESCE(MAX(number), 0) AS n FROM cycles WHERE team_id = $1",
    context ? [teamId, workspaceIdOf(context)] : [teamId],
  );
  let highest = Number(row?.n ?? 0);
  const events = await persistence.many<{ payload: string }>(
    context
      ? "SELECT payload FROM activity WHERE type = 'cycle_changed' AND workspace_id = $1"
      : "SELECT payload FROM activity WHERE type = 'cycle_changed'",
    context ? [workspaceIdOf(context)] : [],
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
    startsAt: string;
    endsAt: string;
    state?: string | null;
  },
  context?: PostgresWorkspaceContext,
): Promise<PostgresCycleRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Cycle name cannot be empty");
  validateDates(input.startsAt, input.endsAt);
  await assertPostgresCycleAccess(persistence, viewer, input.teamId, context);
  const id = newId();
  const timestamp = now();
  await persistence.transaction(async (tx) => {
    await tx.one<{ id: string }>(
      context
        ? "SELECT id FROM teams WHERE id = $1 AND workspace_id = $2 FOR UPDATE"
        : "SELECT id FROM teams WHERE id = $1 FOR UPDATE",
      context ? [input.teamId, workspaceIdOf(context)] : [input.teamId],
    );
    const number = await nextPostgresCycleNumber(tx, input.teamId, context);
    if (context) {
      await tx.execute(
        `INSERT INTO cycles
         (workspace_id, id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, NULL)`,
        [
          workspaceIdOf(context),
          id,
          input.teamId,
          number,
          name,
          input.startsAt,
          input.endsAt,
          input.state ?? "upcoming",
          timestamp,
        ],
      );
    } else {
      await tx.execute(
        `INSERT INTO cycles
         (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NULL)`,
        [
          id,
          input.teamId,
          number,
          name,
          input.startsAt,
          input.endsAt,
          input.state ?? "upcoming",
          timestamp,
        ],
      );
    }
  });
  const row = await getPostgresCycle(persistence, id, context);
  if (!row) throw new Error("PostgreSQL cycle insert returned no row");
  return row;
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
  },
  context?: PostgresWorkspaceContext,
): Promise<PostgresCycleRow> {
  const existing = await getPostgresCycle(persistence, id, context);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
  await assertPostgresCycleAccess(persistence, viewer, existing.team_id, context);
  const startsAt = input.startsAt ?? existing.starts_at;
  const endsAt = input.endsAt ?? existing.ends_at;
  validateDates(startsAt, endsAt);
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
  if (input.state !== undefined && input.state !== null) push("state", resolveState(input.state));
  if (input.archived === true) push("archived_at", now());
  if (input.archived === false) push("archived_at", null);
  if (sets.length) {
    push("updated_at", now());
    params.push(id);
    if (context) {
      params.push(workspaceIdOf(context));
      const row = await persistence.one<PostgresCycleRow>(
        `UPDATE cycles SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND workspace_id = $${params.length} RETURNING *`,
        params,
      );
      if (!row) throw apiError("NOT_FOUND", "Cycle not found");
    } else {
      const row = await persistence.one<PostgresCycleRow>(
        `UPDATE cycles SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (!row) throw apiError("NOT_FOUND", "Cycle not found");
    }
  }
  return (await getPostgresCycle(persistence, id, context))!;
}

async function preserveCycleActivityReferences(
  tx: PersistenceTransaction,
  cycleId: string,
  reference: string,
  context?: PostgresWorkspaceContext,
): Promise<void> {
  const activities = await tx.many<{ id: string; payload: string }>(
    context
      ? "SELECT id, payload FROM activity WHERE type = 'cycle_changed' AND workspace_id = $1"
      : "SELECT id, payload FROM activity WHERE type = 'cycle_changed'",
    context ? [workspaceIdOf(context)] : [],
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
  tx: PersistenceTransaction,
  issueId: string,
  actorId: string,
  payload: Record<string, unknown>,
  createdAt: string,
  context?: PostgresWorkspaceContext,
): Promise<void> {
  await tx.execute(
    context
      ? `INSERT INTO activity (id, workspace_id, issue_id, actor_id, type, payload, created_at)
         VALUES ($1, $2, $3, $4, 'cycle_changed', $5, $6)`
      : `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
         VALUES ($1, $2, $3, 'cycle_changed', $4, $5)`,
    context
      ? [newId(), workspaceIdOf(context), issueId, actorId, JSON.stringify(payload), createdAt]
      : [newId(), issueId, actorId, JSON.stringify(payload), createdAt],
  );
}

export async function deletePostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<boolean> {
  const existing = await getPostgresCycle(persistence, id, context);
  if (!existing) throw apiError("NOT_FOUND", "Cycle not found");
  await assertPostgresCycleAccess(persistence, viewer, existing.team_id, context);
  const team = await getPostgresTeam(persistence, { id: existing.team_id }, context);
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const reference = `${team.key}/${existing.number}`;
  await persistence.transaction(async (tx) => {
    await preserveCycleActivityReferences(tx, id, reference, context);
    const timestamp = now();
    const issues = await tx.many<{ id: string }>(
      context
        ? `UPDATE issues SET cycle_id = NULL, updated_at = $1
           WHERE cycle_id = $2 AND workspace_id = $3
           RETURNING id`
        : `UPDATE issues SET cycle_id = NULL, updated_at = $1
           WHERE cycle_id = $2
           RETURNING id`,
      context ? [timestamp, id, workspaceIdOf(context)] : [timestamp, id],
    );
    for (const issue of issues) {
      await recordCycleActivity(
        tx,
        issue.id,
        viewer.id,
        { from: reference, to: null },
        timestamp,
        context,
      );
    }

    await tx.execute(
      context
        ? "DELETE FROM cycles WHERE id = $1 AND workspace_id = $2"
        : "DELETE FROM cycles WHERE id = $1",
      context ? [id, workspaceIdOf(context)] : [id],
    );
  });
  return true;
}

export async function cycleProgress(
  persistence: Persistence,
  cycleId: string,
  context?: PostgresWorkspaceContext,
): Promise<{ totalIssues: number; completedIssues: number; progress: number }> {
  const row = await persistence.one<{ total: number; done: number | null }>(
    `SELECT count(*)::int AS total,
            COALESCE(sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0)::int AS done
     FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
     WHERE issues.cycle_id = $1 AND issues.archived_at IS NULL
       ${context ? "AND issues.workspace_id = $2 AND workflow_states.workspace_id = $2" : ""}`,
    [cycleId, ...(context ? [workspaceIdOf(context)] : [])],
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
  context?: PostgresWorkspaceContext,
): Promise<number> {
  const from = await getPostgresCycle(persistence, fromCycleId, context);
  const to = await getPostgresCycle(persistence, toCycleId, context);
  if (!from || !to) throw apiError("NOT_FOUND", "Cycle not found");
  if (from.team_id !== to.team_id) {
    throw apiError("VALIDATION_FAILED", "Carry-over requires cycles of the same team");
  }
  await assertPostgresCycleAccess(persistence, viewer, from.team_id, context);
  let affected: readonly { id: string }[] = [];
  await persistence.transaction(async (tx) => {
    const timestamp = now();
    affected = await tx.many<{ id: string }>(
      context
        ? `UPDATE issues SET cycle_id = $2, updated_at = $3
           WHERE cycle_id = $1 AND archived_at IS NULL AND workspace_id = $4
             AND state_id IN (SELECT id FROM workflow_states WHERE type NOT IN ('completed', 'canceled') AND workspace_id = $4)
           RETURNING id`
        : `UPDATE issues SET cycle_id = $2, updated_at = $3
           WHERE cycle_id = $1 AND archived_at IS NULL
             AND state_id IN (SELECT id FROM workflow_states WHERE type NOT IN ('completed', 'canceled'))
           RETURNING id`,
      context
        ? [fromCycleId, toCycleId, timestamp, workspaceIdOf(context)]
        : [fromCycleId, toCycleId, timestamp],
    );
    for (const issue of affected) {
      await recordCycleActivity(
        tx,
        issue.id,
        viewer.id,
        { from: fromCycleId, to: toCycleId },
        timestamp,
        context,
      );
    }
  });
  return affected.length;
}

export async function validatePostgresCycleForTeam(
  persistence: Persistence | PersistenceTransaction,
  cycleId: string,
  teamId: string,
  context?: PostgresWorkspaceContext,
): Promise<void> {
  const cycle = await getPostgresCycle(persistence, cycleId, context);
  if (!cycle) throw apiError("NOT_FOUND", "Cycle not found");
  if (cycle.team_id !== teamId) {
    throw apiError("VALIDATION_FAILED", "Cycle belongs to a different team");
  }
}

export async function canAccessPostgresCycle(
  persistence: Persistence,
  viewer: ActorRow,
  cycleId: string,
  context?: PostgresWorkspaceContext,
): Promise<boolean> {
  const cycle = await getPostgresCycle(persistence, cycleId, context);
  const team = cycle ? await getPostgresTeam(persistence, { id: cycle.team_id }, context) : null;
  return Boolean(team && (await canDiscoverPostgresTeam(persistence, viewer, team, context)));
}
