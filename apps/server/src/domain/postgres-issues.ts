import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import {
  canDiscoverPostgresTeam,
  getPostgresDefaultState,
  getPostgresTeam,
  getPostgresWorkflowState,
  isPostgresTeamMember,
  listPostgresTeams,
} from "./postgres-teams.ts";
import {
  buildIssueFilter,
  decodeCursor,
  encodeCursor,
  ORDER_COLUMNS,
  ParamSink,
  type IssueFilter,
  type IssueOrder,
} from "./filters.ts";
import { mapIssue, type IssueCreateInput, type IssueRow, type IssueUpdateInput } from "./issues.ts";
import type { ActorRow, AuthContext } from "../auth/viewer.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import type { TeamRow } from "./teams.ts";
import { apiError } from "../graphql/errors.ts";
import { isWorkspaceAdmin } from "../auth/permissions.ts";
import { newId, now } from "../db/util.ts";
import { applyPostgresLabelOps } from "./postgres-labels.ts";

const SELECT_ISSUE =
  "SELECT issues.*, teams.key AS team_key FROM issues JOIN teams ON teams.id = issues.team_id";

function postgresPlaceholders(sql: string): string {
  return sql.replace(/\?(\d+)/g, (_match, number: string) => `$${number}`);
}

function valuesOf(params: ParamSink): SqlValue[] {
  return params.values as SqlValue[];
}

function postgresSearchQuery(search: string): string | null {
  const phrases = [...search.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  const rest = search.replace(/"[^"]*"/g, " ");
  const words = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]+/gu)
      ?.map((word) => `${word}:*`) ?? [];
  const exactPhrases = phrases
    .map((phrase) => {
      const phraseWords =
        phrase
          .normalize("NFD")
          .replace(/\p{M}/gu, "")
          .match(/[\p{L}\p{N}]+/gu) ?? [];
      return phraseWords.length > 0 ? phraseWords.join(" <-> ") : "";
    })
    .filter(Boolean);
  const prefixes = words(rest);
  const query = [...exactPhrases, ...prefixes].join(" & ");
  return query || null;
}

function postgresSearchClause(search: string, params: ParamSink): string {
  const query = postgresSearchQuery(search);
  if (query) return `issues.search_vector @@ to_tsquery('simple', ${params.add(query)})`;
  // Mantiene la compatibilidad de FTS5: una o más frases vacías ignoran la
  // búsqueda, mientras que tokens sin letras (por ejemplo `*`) no matchean.
  const quoted = /"[^"]*"/;
  return quoted.test(search) && !search.replace(/"[^"]*"/g, " ").trim() ? "1 = 1" : "1 = 0";
}

const POSTGRES_FILTER_OPTIONS = { searchClause: postgresSearchClause };

function orderValue(row: IssueRow, orderBy: IssueOrder): string {
  return orderBy === "UPDATED_ASC" || orderBy === "UPDATED_DESC" ? row.updated_at : row.created_at;
}

function addTeamScope(params: ParamSink, teamIds: readonly string[]): string {
  if (teamIds.length === 0) return "1 = 0";
  return `issues.team_id IN (${teamIds.map((teamId) => params.add(teamId)).join(", ")})`;
}

function addArchiveScope(filter: IssueFilter): string {
  return filter.includeArchived
    ? "1 = 1"
    : "issues.archived_at IS NULL AND teams.archived_at IS NULL";
}

export interface PostgresIssuePage {
  rows: IssueRow[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export async function getPostgresIssue(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<IssueRow | null> {
  return persistence.one<IssueRow>(`${SELECT_ISSUE} WHERE issues.id = $1`, [id]);
}

/** Acepta UUID o identificador legible tipo PRB-126. */
export async function getPostgresIssueByRef(
  persistence: Persistence | PersistenceTransaction,
  ref: string,
): Promise<IssueRow | null> {
  const match = ref.match(/^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/);
  if (match) {
    return persistence.one<IssueRow>(
      `${SELECT_ISSUE} WHERE teams.key = $1 AND issues.number = $2`,
      [match[1]!.toUpperCase(), Number(match[2])],
    );
  }
  return getPostgresIssue(persistence, ref);
}

export async function listPostgresChildren(
  persistence: Persistence,
  parentId: string,
  includeArchived = false,
): Promise<IssueRow[]> {
  return [
    ...(await persistence.many<IssueRow>(
      `${SELECT_ISSUE}
       WHERE issues.parent_id = $1
       ${includeArchived ? "" : "AND issues.archived_at IS NULL AND teams.archived_at IS NULL"}
       ORDER BY issues.created_at, issues.id`,
      [parentId],
    )),
  ];
}

export async function accessiblePostgresTeamIds(
  persistence: Persistence,
  viewer: ActorRow,
  auth: AuthContext | null,
): Promise<string[]> {
  const teams = await listPostgresTeams(persistence, true);
  const visible: string[] = [];
  for (const team of teams) {
    if (
      (await canDiscoverPostgresTeam(persistence, viewer, team)) &&
      (!auth?.teamIds || auth.teamIds.includes(team.id))
    ) {
      visible.push(team.id);
    }
  }
  return visible;
}

export async function listPostgresIssues(
  persistence: Persistence,
  options: {
    filter?: IssueFilter | null;
    first: number;
    after?: string | null;
    orderBy?: IssueOrder | null;
    teamIds: readonly string[];
  },
): Promise<PostgresIssuePage> {
  if (!Number.isInteger(options.first) || options.first < 1 || options.first > 250) {
    throw apiError("VALIDATION_FAILED", "first must be between 1 and 250");
  }
  const orderBy = options.orderBy ?? "CREATED_DESC";
  const order = ORDER_COLUMNS[orderBy];
  if (!order) throw apiError("VALIDATION_FAILED", "Invalid issue order");
  const filter = options.filter ?? {};

  const params = new ParamSink();
  const clauses = [
    buildIssueFilter(filter, params, POSTGRES_FILTER_OPTIONS),
    addTeamScope(params, options.teamIds),
    addArchiveScope(filter),
  ];

  if (options.after !== undefined && options.after !== null) {
    const decoded = decodeCursor(options.after);
    if (!decoded || decoded.orderBy !== orderBy) {
      throw apiError("VALIDATION_FAILED", "Invalid issue cursor");
    }
    const cursorParams = new ParamSink();
    const cursorId = cursorParams.add(decoded.id);
    const cursorClauses = [
      buildIssueFilter(filter, cursorParams, POSTGRES_FILTER_OPTIONS),
      addTeamScope(cursorParams, options.teamIds),
      addArchiveScope(filter),
    ];
    const cursorRow = await persistence.one<IssueRow>(
      `${SELECT_ISSUE} WHERE issues.id = ${postgresPlaceholders(cursorId)} AND ${cursorClauses.join(" AND ")}`.replace(
        /\?(\d+)/g,
        (_match, number: string) => `$${number}`,
      ),
      valuesOf(cursorParams),
    );
    if (!cursorRow || orderValue(cursorRow, orderBy) !== decoded.orderValue) {
      throw apiError("VALIDATION_FAILED", "Invalid issue cursor");
    }
    const comparator = order.direction === "DESC" ? "<" : ">";
    clauses.push(
      `(${order.column}, issues.id) ${comparator} (${params.add(decoded.orderValue)}, ${params.add(decoded.id)})`,
    );
  }

  const rows = await persistence.many<IssueRow>(
    `${SELECT_ISSUE}
     WHERE ${clauses.join(" AND ")}
     ORDER BY ${order.column} ${order.direction}, issues.id ${order.direction}
     LIMIT ${options.first + 1}`.replace(/\?(\d+)/g, (_match, number: string) => `$${number}`),
    valuesOf(params),
  );
  const page = [...rows].slice(0, options.first);
  const last = page[page.length - 1];
  return {
    rows: page,
    hasNextPage: rows.length > options.first,
    endCursor: last ? encodeCursor(orderValue(last, orderBy), last.id, orderBy) : null,
  };
}

function assertPostgresPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw apiError("VALIDATION_FAILED", "Priority must be an integer between 0 and 4");
  }
}

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function assertPostgresIssueDependencies(input: Record<string, unknown>): void {
  const unsupported = ["projectId", "milestoneId", "cycleId"];
  const field = unsupported.find((name) => hasOwn(input, name));
  if (field) {
    throw apiError(
      "VALIDATION_FAILED",
      `Issue ${field} is not yet available with PostgreSQL persistence`,
    );
  }
}

async function requirePostgresIssueWrite(
  persistence: Persistence | PersistenceTransaction,
  viewer: ActorRow,
  teamId: string,
): Promise<TeamRow> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
  if (
    !isWorkspaceAdmin(viewer) &&
    !(await isPostgresTeamMember(persistence, teamId, viewer.id)) &&
    !(team.visibility === "public" && team.access_policy === "workspace_members")
  ) {
    throw apiError("UNAUTHORIZED", "Team access policy does not allow this operation");
  }
  return team;
}

async function assertPostgresAssignee(
  persistence: Persistence | PersistenceTransaction,
  viewer: ActorRow,
  team: Awaited<ReturnType<typeof getPostgresTeam>>,
  actorId: string,
): Promise<void> {
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const actor = await getPostgresActor(persistence, actorId);
  if (!actor || actor.status !== "active") {
    throw apiError("UNAUTHORIZED", "Assignee must be an active actor");
  }
  if (
    team.access_policy === "team_members" &&
    !isWorkspaceAdmin(viewer) &&
    !(await isPostgresTeamMember(persistence, team.id, actorId))
  ) {
    throw apiError("UNAUTHORIZED", "Assignee must be a Team member");
  }
}

async function assertPostgresParent(
  persistence: Persistence | PersistenceTransaction,
  issueId: string | null,
  teamId: string,
  parentId: string,
): Promise<void> {
  if (issueId === parentId)
    throw apiError("VALIDATION_FAILED", "An issue cannot be its own parent");
  const parent = await getPostgresIssue(persistence, parentId);
  if (!parent) throw apiError("NOT_FOUND", `Issue not found: ${parentId}`);
  if (parent.team_id !== teamId) {
    throw apiError("VALIDATION_FAILED", "Parent issue must belong to the same Team");
  }
  if (issueId) {
    const cycle = await persistence.one(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT $1
         UNION ALL
         SELECT issues.parent_id FROM issues JOIN ancestors ON issues.id = ancestors.id
         WHERE issues.parent_id IS NOT NULL
       ) SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
      [parentId, issueId],
    );
    if (cycle) throw apiError("VALIDATION_FAILED", "Parent assignment would create a cycle");
  }
}

async function recordPostgresActivity(
  persistence: PersistenceTransaction,
  issueId: string,
  actorId: string,
  type: string,
  payload: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  await persistence.execute(
    `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId(), issueId, actorId, type, JSON.stringify(payload), createdAt],
  );
}

export async function createPostgresIssue(
  persistence: Persistence,
  viewer: ActorRow,
  input: IssueCreateInput,
): Promise<IssueRow> {
  return persistence.transaction(async (tx) => {
    assertPostgresIssueDependencies(input as unknown as Record<string, unknown>);
    const team = input.teamId
      ? await getPostgresTeam(tx, { id: input.teamId })
      : await getPostgresTeam(tx, { key: input.teamKey });
    if (!team) throw apiError("NOT_FOUND", "Team not found");
    await requirePostgresIssueWrite(tx, viewer, team.id);
    const title = input.title.trim();
    if (!title) throw apiError("VALIDATION_FAILED", "Issue title cannot be empty");
    const priority = input.priority ?? 0;
    assertPostgresPriority(priority);
    const state = input.stateId
      ? await getPostgresWorkflowState(tx, input.stateId)
      : team.default_state_id
        ? await getPostgresWorkflowState(tx, team.default_state_id)
        : null;
    if (!state || state.team_id !== team.id) {
      throw apiError("VALIDATION_FAILED", "Workflow state does not belong to the Team");
    }
    if (input.assigneeId) await assertPostgresAssignee(tx, viewer, team, input.assigneeId);
    if (input.parentId) await assertPostgresParent(tx, null, team.id, input.parentId);
    if (input.creatorId) {
      const creator = await getPostgresActor(tx, input.creatorId);
      if (!creator) throw apiError("NOT_FOUND", "Creator actor not found");
    }
    const createdAt = input.createdAt ?? now();
    const issueId = newId();
    let number: number;
    if (input.number != null) {
      if (!Number.isInteger(input.number) || input.number < 1) {
        throw apiError("VALIDATION_FAILED", "Issue number must be a positive integer");
      }
      if (
        await tx.one("SELECT 1 FROM issues WHERE team_id = $1 AND number = $2", [
          team.id,
          input.number,
        ])
      ) {
        throw apiError(
          "VALIDATION_FAILED",
          `Issue number ${input.number} is already taken in this team`,
        );
      }
      number = input.number;
      await tx.execute(
        `UPDATE teams SET next_issue_number = GREATEST(next_issue_number, $2), updated_at = $3 WHERE id = $1`,
        [team.id, number + 1, createdAt],
      );
    } else {
      const allocated = await tx.one<{ number: number }>(
        `UPDATE teams
         SET next_issue_number = GREATEST(
           next_issue_number,
           COALESCE((SELECT MAX(number) + 1 FROM issues WHERE team_id = $1), 1)
         ) + 1,
         updated_at = $2
         WHERE id = $1
         RETURNING next_issue_number - 1 AS number`,
        [team.id, createdAt],
      );
      if (!allocated) throw apiError("NOT_FOUND", "Team not found");
      number = Number(allocated.number);
    }
    await tx.execute(
      `INSERT INTO issues
       (id, team_id, number, title, description, state_id, priority, assignee_id, parent_id,
        project_id, creator_id, sort_order, created_at, updated_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, 0, $11, $11, NULL)`,
      [
        issueId,
        team.id,
        number,
        title,
        input.description ?? null,
        state.id,
        priority,
        input.assigneeId ?? null,
        input.parentId ?? null,
        input.creatorId ?? viewer.id,
        createdAt,
      ],
    );
    if (input.labelIds?.length) {
      await applyPostgresLabelOps(
        tx,
        viewer.id,
        { ...(await getPostgresIssue(tx, issueId))!, id: issueId },
        {
          labelIds: input.labelIds,
        },
      );
    }
    await recordPostgresActivity(tx, issueId, viewer.id, "created", { title, number }, createdAt);
    const row = await getPostgresIssue(tx, issueId);
    if (!row) throw apiError("NOT_FOUND", "Issue not found after creation");
    return row;
  });
}

export async function updatePostgresIssue(
  persistence: Persistence,
  viewer: ActorRow,
  ref: string,
  input: IssueUpdateInput,
): Promise<{ row: IssueRow; changes: Array<{ field: string; from: unknown; to: unknown }> }> {
  return persistence.transaction(async (tx) => {
    assertPostgresIssueDependencies(input as unknown as Record<string, unknown>);
    const issue = await getPostgresIssueByRef(tx, ref);
    if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
    const team = await requirePostgresIssueWrite(tx, viewer, issue.team_id);
    const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const push = (column: string, value: SqlValue) => {
      sets.push(`${column} = $${params.length + 1}`);
      params.push(value);
    };
    const activity: Array<{ type: string; payload: Record<string, unknown> }> = [];
    if (input.title !== undefined && input.title !== null) {
      const title = input.title.trim();
      if (!title) throw apiError("VALIDATION_FAILED", "Issue title cannot be empty");
      if (title !== issue.title) {
        push("title", title);
        changes.push({ field: "title", from: issue.title, to: title });
        activity.push({ type: "title_changed", payload: { from: issue.title, to: title } });
      }
    }
    if (input.description !== undefined && input.description !== issue.description) {
      push("description", input.description);
      changes.push({ field: "description", from: issue.description, to: input.description });
      activity.push({
        type: "description_changed",
        payload: { from: issue.description, to: input.description },
      });
    }
    if (input.stateId !== undefined && input.stateId !== issue.state_id) {
      if (!input.stateId) throw apiError("VALIDATION_FAILED", "Workflow state is required");
      const state = await getPostgresWorkflowState(tx, input.stateId);
      if (!state || state.team_id !== team.id) {
        throw apiError("VALIDATION_FAILED", "Workflow state does not belong to the Team");
      }
      push("state_id", input.stateId);
      changes.push({ field: "state", from: issue.state_id, to: input.stateId });
      activity.push({
        type: "state_changed",
        payload: { from: issue.state_id, to: input.stateId },
      });
    }
    if (input.priority !== undefined && input.priority !== issue.priority) {
      const priority = input.priority ?? 0;
      assertPostgresPriority(priority);
      push("priority", priority);
      changes.push({ field: "priority", from: issue.priority, to: priority });
      activity.push({ type: "priority_changed", payload: { from: issue.priority, to: priority } });
    }
    if (input.assigneeId !== undefined && input.assigneeId !== issue.assignee_id) {
      if (input.assigneeId) await assertPostgresAssignee(tx, viewer, team, input.assigneeId);
      push("assignee_id", input.assigneeId);
      changes.push({ field: "assignee", from: issue.assignee_id, to: input.assigneeId });
      activity.push({
        type: "assignee_changed",
        payload: { from: issue.assignee_id, to: input.assigneeId },
      });
    }
    if (input.parentId !== undefined && input.parentId !== issue.parent_id) {
      if (input.parentId) await assertPostgresParent(tx, issue.id, team.id, input.parentId);
      push("parent_id", input.parentId);
      changes.push({ field: "parent", from: issue.parent_id, to: input.parentId });
      activity.push({
        type: "parent_changed",
        payload: { from: issue.parent_id, to: input.parentId },
      });
    }
    if (
      input.sortOrder !== undefined &&
      input.sortOrder !== null &&
      input.sortOrder !== issue.sort_order
    ) {
      push("sort_order", input.sortOrder);
      activity.push({
        type: "sort_order_changed",
        payload: { from: issue.sort_order, to: input.sortOrder },
      });
    }
    const labelsChanged = await applyPostgresLabelOps(tx, viewer.id, issue, input);
    if (labelsChanged && sets.length === 0) {
      // label operations are part of the same transaction and still advance updated_at.
      push("updated_at", now());
    }
    if (sets.length > 0) {
      const updatedAt = now();
      push("updated_at", updatedAt);
      params.push(issue.id);
      await tx.execute(`UPDATE issues SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
      for (const entry of activity)
        await recordPostgresActivity(tx, issue.id, viewer.id, entry.type, entry.payload, updatedAt);
    }
    const row = (await getPostgresIssue(tx, issue.id))!;
    return { row, changes };
  });
}

export async function archivePostgresIssue(
  persistence: Persistence,
  viewer: ActorRow,
  ref: string,
): Promise<IssueRow> {
  return persistence.transaction(async (tx) => {
    const issue = await getPostgresIssueByRef(tx, ref);
    if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
    await requirePostgresIssueWrite(tx, viewer, issue.team_id);
    if (!issue.archived_at) {
      const archivedAt = now();
      await tx.execute("UPDATE issues SET archived_at = $1, updated_at = $1 WHERE id = $2", [
        archivedAt,
        issue.id,
      ]);
      await recordPostgresActivity(tx, issue.id, viewer.id, "archived", {}, archivedAt);
    }
    return (await getPostgresIssue(tx, issue.id))!;
  });
}

export { mapIssue };
