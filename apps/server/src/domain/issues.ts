// Dominio de issues: creación, actualización, archivado, identificadores y lookups.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";
import {
  buildIssueFilter, decodeCursor, encodeCursor, ORDER_COLUMNS, ParamSink,
  type IssueFilter, type IssueOrder,
} from "./filters.ts";
import { applyLabelOps, type LabelOps } from "./labels.ts";
import { assertMilestoneMatchesProject } from "./milestones.ts";
import { projectIncludesTeam } from "./projects.ts";
import { getTeam } from "./teams.ts";

export interface IssueRow {
  id: string;
  team_id: string;
  number: number;
  title: string;
  description: string | null;
  state_id: string;
  priority: number;
  assignee_id: string | null;
  parent_id: string | null;
  project_id: string | null;
  milestone_id: string | null;
  creator_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  team_key: string;
}

const SELECT_ISSUE =
  "SELECT issues.*, teams.key AS team_key FROM issues JOIN teams ON teams.id = issues.team_id";

export function identifierOf(row: IssueRow): string {
  return `${row.team_key}-${row.number}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function mapIssue(row: IssueRow) {
  return {
    id: row.id,
    identifier: identifierOf(row),
    title: row.title,
    description: row.description,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    _row: row,
  };
}

export function getIssue(db: Database, id: string): IssueRow | null {
  return db.query(`${SELECT_ISSUE} WHERE issues.id = ?1`).get(id) as IssueRow | null;
}

/** Acepta UUID o identificador legible tipo AT-126 (spec §4, Convenciones). */
export function getIssueByRef(db: Database, ref: string): IssueRow | null {
  const match = ref.match(/^([A-Za-z][A-Za-z0-9]{0,7})-(\d+)$/);
  if (match) {
    return db
      .query(`${SELECT_ISSUE} WHERE teams.key = ?1 AND issues.number = ?2`)
      .get(match[1]!.toUpperCase(), Number(match[2])) as IssueRow | null;
  }
  return getIssue(db, ref);
}

function requireIssue(db: Database, ref: string): IssueRow {
  const row = getIssueByRef(db, ref);
  if (!row) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
  return row;
}

function validatePriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw apiError("VALIDATION_FAILED", "Priority must be an integer between 0 and 4");
  }
}

function validateState(db: Database, teamId: string, stateId: string): void {
  const state = db
    .query("SELECT id FROM workflow_states WHERE id = ?1 AND team_id = ?2")
    .get(stateId, teamId);
  if (!state) throw apiError("VALIDATION_FAILED", "State does not belong to the issue's team");
}

function validateAssignee(db: Database, assigneeId: string): void {
  const actor = db.query("SELECT id FROM actors WHERE id = ?1").get(assigneeId);
  if (!actor) throw apiError("NOT_FOUND", "Assignee not found");
}

function validateParent(db: Database, issue: { id: string; team_id: string }, parentId: string): void {
  const parent = getIssue(db, parentId);
  if (!parent) throw apiError("NOT_FOUND", "Parent issue not found");
  if (parent.team_id !== issue.team_id) {
    throw apiError("VALIDATION_FAILED", "Parent issue must belong to the same team");
  }
  // Evita ciclos: sube por la cadena de padres.
  let cursor: string | null = parentId;
  for (let depth = 0; cursor && depth < 100; depth += 1) {
    if (cursor === issue.id) {
      throw apiError("VALIDATION_FAILED", "Parent assignment would create a cycle");
    }
    const next = db.query("SELECT parent_id FROM issues WHERE id = ?1").get(cursor) as
      | { parent_id: string | null }
      | null;
    cursor = next?.parent_id ?? null;
  }
}

export interface IssueCreateInput {
  teamId?: string | null;
  teamKey?: string | null;
  /** Fija el número del identificador (imports); default: numeración automática. */
  number?: number | null;
  title: string;
  description?: string | null;
  stateId?: string | null;
  priority?: number | null;
  assigneeId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
  /** Labels a aplicar en la creación (evita un issueUpdate extra en imports). */
  labelIds?: string[] | null;
  milestoneId?: string | null;
  /** Fecha de creación original (imports); default: ahora. */
  createdAt?: string | null;
  /** Autor original (imports); default: el actor de la API key. */
  creatorId?: string | null;
}

export function createIssue(db: Database, actorId: string, input: IssueCreateInput): IssueRow {
  const team = getTeam(db, { id: input.teamId, key: input.teamKey });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  const title = input.title.trim();
  if (!title) throw apiError("VALIDATION_FAILED", "Issue title cannot be empty");
  if (input.priority != null) validatePriority(input.priority);
  if (input.stateId) validateState(db, team.id, input.stateId);
  if (input.assigneeId) validateAssignee(db, input.assigneeId);
  if (input.projectId) {
    const project = db.query("SELECT id FROM projects WHERE id = ?1").get(input.projectId);
    if (!project) throw apiError("NOT_FOUND", "Project not found");
    if (!projectIncludesTeam(db, input.projectId, team.id)) {
      throw apiError("VALIDATION_FAILED", "Project does not include the issue's team");
    }
  }

  if (input.number != null) {
    if (!Number.isInteger(input.number) || input.number < 1) {
      throw apiError("VALIDATION_FAILED", "Issue number must be a positive integer");
    }
    const taken = db
      .query("SELECT id FROM issues WHERE team_id = ?1 AND number = ?2")
      .get(team.id, input.number);
    if (taken) {
      throw apiError("VALIDATION_FAILED", `Issue number ${input.number} is already taken in this team`);
    }
  }

  if (input.milestoneId) {
    assertMilestoneMatchesProject(db, input.milestoneId, input.projectId ?? null);
  }
  if (input.createdAt != null && Number.isNaN(Date.parse(input.createdAt))) {
    throw apiError("VALIDATION_FAILED", "createdAt must be a valid ISO-8601 date");
  }
  if (input.creatorId != null && !db.query("SELECT id FROM actors WHERE id = ?1").get(input.creatorId)) {
    throw apiError("NOT_FOUND", "Creator actor not found");
  }
  // En imports, autoría y fecha originales; si no, el actor de la key y ahora.
  const creatorId = input.creatorId ?? actorId;
  const createdAt = input.createdAt ?? null;

  const id = newId();
  db.transaction(() => {
    // Numeración por team, atómica dentro de la transacción. Con número explícito
    // (imports), next_issue_number salta más allá para no colisionar después.
    const numbered = input.number != null
      ? (db.query(
          "UPDATE teams SET next_issue_number = max(next_issue_number, ?2 + 1) WHERE id = ?1 RETURNING ?2 AS number",
        ).get(team.id, input.number) as { number: number })
      : (db.query(
          "UPDATE teams SET next_issue_number = next_issue_number + 1 WHERE id = ?1 RETURNING next_issue_number - 1 AS number",
        ).get(team.id) as { number: number });

    // Estado default: el de menor posición (Backlog en el workflow default).
    const stateId =
      input.stateId ??
      (db.query("SELECT id FROM workflow_states WHERE team_id = ?1 ORDER BY position LIMIT 1")
        .get(team.id) as { id: string }).id;

    if (input.parentId) validateParent(db, { id, team_id: team.id }, input.parentId);

    const timestamp = createdAt ?? now();
    db.query(
      `INSERT INTO issues (id, team_id, number, title, description, state_id, priority,
         assignee_id, parent_id, project_id, milestone_id, creator_id, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
    ).run(
      id, team.id, numbered.number, title, input.description ?? null, stateId,
      input.priority ?? 0, input.assigneeId ?? null, input.parentId ?? null,
      input.projectId ?? null, input.milestoneId ?? null, creatorId, 0, timestamp,
    );
    // Payload completo: el log tiene que alcanzar para reconstruir el issue
    // sin depender del snapshot (AT-165, prerequisito de la Fase 3).
    recordActivity(db, id, creatorId, "created", {
      title,
      description: input.description ?? null,
      teamId: team.id,
      number: numbered.number,
      priority: input.priority ?? 0,
      stateId,
      assigneeId: input.assigneeId ?? null,
      parentId: input.parentId ?? null,
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
    }, createdAt ?? undefined);
    if (input.labelIds?.length) {
      applyLabelOps(db, actorId, getIssue(db, id)!, { labelIds: input.labelIds });
    }
  })();
  return getIssue(db, id)!;
}

export interface IssueUpdateInput extends LabelOps {
  title?: string | null;
  description?: string | null;
  stateId?: string | null;
  priority?: number | null;
  assigneeId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
  milestoneId?: string | null;
  sortOrder?: number | null;
}

export interface IssueChange {
  field: string;
  from: unknown;
  to: unknown;
}

export function updateIssue(
  db: Database,
  actorId: string,
  ref: string,
  input: IssueUpdateInput,
): { row: IssueRow; changes: IssueChange[] } {
  const issue = requireIssue(db, ref);
  const changes: IssueChange[] = [];
  const sets: string[] = [];
  const params: unknown[] = [];

  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };

  db.transaction(() => {
    if (input.title !== undefined && input.title !== null) {
      const title = input.title.trim();
      if (!title) throw apiError("VALIDATION_FAILED", "Issue title cannot be empty");
      if (title !== issue.title) {
        push("title", title);
        changes.push({ field: "title", from: issue.title, to: title });
        recordActivity(db, issue.id, actorId, "title_changed", { from: issue.title, to: title });
      }
    }
    if (input.description !== undefined && input.description !== issue.description) {
      push("description", input.description);
      changes.push({ field: "description", from: issue.description, to: input.description });
      recordActivity(db, issue.id, actorId, "description_changed", { to: input.description ?? null });
    }
    if (input.stateId != null && input.stateId !== issue.state_id) {
      validateState(db, issue.team_id, input.stateId);
      push("state_id", input.stateId);
      changes.push({ field: "state", from: issue.state_id, to: input.stateId });
      recordActivity(db, issue.id, actorId, "state_changed", { from: issue.state_id, to: input.stateId });
    }
    if (input.priority != null && input.priority !== issue.priority) {
      validatePriority(input.priority);
      push("priority", input.priority);
      changes.push({ field: "priority", from: issue.priority, to: input.priority });
      recordActivity(db, issue.id, actorId, "priority_changed", { from: issue.priority, to: input.priority });
    }
    if (input.assigneeId !== undefined && input.assigneeId !== issue.assignee_id) {
      if (input.assigneeId !== null) validateAssignee(db, input.assigneeId);
      push("assignee_id", input.assigneeId);
      changes.push({ field: "assignee", from: issue.assignee_id, to: input.assigneeId });
      recordActivity(db, issue.id, actorId, "assigned", { from: issue.assignee_id, to: input.assigneeId });
    }
    if (input.parentId !== undefined && input.parentId !== issue.parent_id) {
      if (input.parentId !== null) validateParent(db, issue, input.parentId);
      push("parent_id", input.parentId);
      changes.push({ field: "parent", from: issue.parent_id, to: input.parentId });
      recordActivity(db, issue.id, actorId, "parent_changed", { from: issue.parent_id, to: input.parentId });
    }
    if (input.projectId !== undefined && input.projectId !== issue.project_id) {
      if (input.projectId !== null) {
        const project = db.query("SELECT id FROM projects WHERE id = ?1").get(input.projectId);
        if (!project) throw apiError("NOT_FOUND", "Project not found");
        if (!projectIncludesTeam(db, input.projectId, issue.team_id)) {
          throw apiError("VALIDATION_FAILED", "Project does not include the issue's team");
        }
      }
      push("project_id", input.projectId);
      changes.push({ field: "project", from: issue.project_id, to: input.projectId });
      recordActivity(db, issue.id, actorId, "project_changed", { from: issue.project_id, to: input.projectId });

      // Al cambiar de proyecto, un milestone del proyecto anterior queda huérfano:
      // se limpia salvo que la misma mutación esté seteando uno nuevo.
      if (issue.milestone_id && input.milestoneId === undefined) {
        push("milestone_id", null);
        changes.push({ field: "milestone", from: issue.milestone_id, to: null });
        recordActivity(db, issue.id, actorId, "milestone_changed", { from: issue.milestone_id, to: null });
      }
    }
    if (input.milestoneId !== undefined && input.milestoneId !== issue.milestone_id) {
      if (input.milestoneId !== null) {
        // El proyecto efectivo: el que se está seteando en esta misma mutación, o el actual.
        const projectId = input.projectId !== undefined ? input.projectId : issue.project_id;
        assertMilestoneMatchesProject(db, input.milestoneId, projectId);
      }
      push("milestone_id", input.milestoneId);
      changes.push({ field: "milestone", from: issue.milestone_id, to: input.milestoneId });
      recordActivity(db, issue.id, actorId, "milestone_changed", { from: issue.milestone_id, to: input.milestoneId });
    }
    if (input.sortOrder != null && input.sortOrder !== issue.sort_order) {
      push("sort_order", input.sortOrder);
    }

    const labelsChanged = applyLabelOps(db, actorId, issue, input);
    if (labelsChanged) {
      changes.push({ field: "labels", from: null, to: null });
      if (sets.length === 0) {
        push("updated_at", now());
        params.push(issue.id);
        db.query(`UPDATE issues SET updated_at = ?1 WHERE id = ?2`).run(...(params as never[]));
        // updated_at ya quedó seteado; evita duplicar el UPDATE de abajo.
        sets.length = 0;
        params.length = 0;
      }
    }

    if (sets.length > 0) {
      push("updated_at", now());
      params.push(issue.id);
      db.query(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
        ...(params as never[]),
      );
    }
  })();

  return { row: getIssue(db, issue.id)!, changes };
}

export function archiveIssue(db: Database, actorId: string, ref: string): IssueRow {
  const issue = requireIssue(db, ref);
  if (!issue.archived_at) {
    db.query("UPDATE issues SET archived_at = ?1, updated_at = ?1 WHERE id = ?2").run(now(), issue.id);
    recordActivity(db, issue.id, actorId, "archived", {});
  }
  return getIssue(db, issue.id)!;
}

export function listChildren(db: Database, issueId: string): IssueRow[] {
  return db
    .query(`${SELECT_ISSUE} WHERE issues.parent_id = ?1 ORDER BY issues.created_at`)
    .all(issueId) as IssueRow[];
}

// Listado con filtros componibles, orden estable y paginación por cursor (AT-138).

export interface ListIssuesOptions {
  filter?: IssueFilter | null;
  first: number;
  after?: string | null;
  orderBy?: IssueOrder | null;
}

export interface IssuePage {
  rows: IssueRow[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export function listIssues(db: Database, options: ListIssuesOptions): IssuePage {
  const params = new ParamSink();
  const filter = options.filter ?? {};
  const clauses = [buildIssueFilter(filter, params)];
  if (!filter.includeArchived) clauses.push("issues.archived_at IS NULL");

  const order = ORDER_COLUMNS[options.orderBy ?? "CREATED_DESC"];
  if (options.after) {
    const decoded = decodeCursor(options.after);
    if (decoded) {
      const comparator = order.direction === "DESC" ? "<" : ">";
      clauses.push(
        `(${order.column}, issues.id) ${comparator} (${params.add(decoded[0])}, ${params.add(decoded[1])})`,
      );
    }
  }

  const rows = db
    .query(
      `${SELECT_ISSUE} WHERE ${clauses.join(" AND ")}
       ORDER BY ${order.column} ${order.direction}, issues.id ${order.direction}
       LIMIT ${options.first + 1}`,
    )
    .all(...(params.values as never[])) as IssueRow[];

  const page = rows.slice(0, options.first);
  const last = page[page.length - 1];
  const orderValue = (row: IssueRow): string =>
    order.column === "issues.updated_at" ? row.updated_at : row.created_at;
  return {
    rows: page,
    hasNextPage: rows.length > options.first,
    endCursor: last ? encodeCursor(orderValue(last), last.id) : null,
  };
}
