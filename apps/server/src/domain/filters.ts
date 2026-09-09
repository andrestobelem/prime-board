import { parseDateTime } from "./datetime.ts";

// Motor de filtros componibles de issues (spec §4): comparadores + and/or
// anidables, búsqueda full-text (FTS5) y orden con cursor estable.

export interface IDComparator {
  eq?: string | null;
  neq?: string | null;
  in?: string[] | null;
  nin?: string[] | null;
  /** true: campo IS NULL; false: campo IS NOT NULL. */
  null?: boolean | null;
}

export interface IntComparator {
  eq?: number | null;
  neq?: number | null;
  in?: number[] | null;
  gte?: number | null;
  lte?: number | null;
}

export interface DateTimeComparator {
  eq?: string | null;
  neq?: string | null;
  in?: string[] | null;
  nin?: string[] | null;
  gte?: string | null;
  lte?: string | null;
  null?: boolean | null;
}

export interface StateTypeComparator {
  eq?: string | null;
  in?: string[] | null;
}

export interface LabelComparator {
  /** El issue tiene esta label. */
  includes?: string | null;
  /** El issue tiene todas estas labels. */
  includesAll?: string[] | null;
}

export interface IssueFilter {
  team?: IDComparator | null;
  state?: IDComparator | null;
  stateType?: StateTypeComparator | null;
  assignee?: IDComparator | null;
  creator?: IDComparator | null;
  project?: IDComparator | null;
  milestone?: IDComparator | null;
  cycle?: IDComparator | null;
  parent?: IDComparator | null;
  priority?: IntComparator | null;
  dueDate?: DateTimeComparator | null;
  startedAt?: DateTimeComparator | null;
  completedAt?: DateTimeComparator | null;
  canceledAt?: DateTimeComparator | null;
  labels?: LabelComparator | null;
  /** Full-text sobre título y descripción (FTS5). */
  search?: string | null;
  /** true: issues que sigue el actor autenticado; false: issues que no sigue. */
  subscribed?: boolean | null;
  /**
   * true: issues abiertos cuyos bloqueantes están todos cerrados (el frontier
   * de /wayfinder); false: issues con al menos un bloqueante abierto.
   */
  unblocked?: boolean | null;
  includeArchived?: boolean | null;
  and?: IssueFilter[] | null;
  or?: IssueFilter[] | null;
}

/** Acumulador de parámetros posicionales (?N) compartido por todo el árbol. */
export class ParamSink {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

function idClauses(column: string, comparator: IDComparator, params: ParamSink): string[] {
  const clauses: string[] = [];
  if (comparator.eq != null) clauses.push(`${column} = ${params.add(comparator.eq)}`);
  if (comparator.neq != null) clauses.push(`${column} != ${params.add(comparator.neq)}`);
  if (comparator.in?.length) {
    clauses.push(`${column} IN (${comparator.in.map((v) => params.add(v)).join(", ")})`);
  }
  if (comparator.nin?.length) {
    clauses.push(`${column} NOT IN (${comparator.nin.map((v) => params.add(v)).join(", ")})`);
  }
  if (comparator.null === true) clauses.push(`${column} IS NULL`);
  if (comparator.null === false) clauses.push(`${column} IS NOT NULL`);
  return clauses;
}

function intClauses(column: string, comparator: IntComparator, params: ParamSink): string[] {
  const clauses: string[] = [];
  if (comparator.eq != null) clauses.push(`${column} = ${params.add(comparator.eq)}`);
  if (comparator.neq != null) clauses.push(`${column} != ${params.add(comparator.neq)}`);
  if (comparator.in?.length) {
    clauses.push(`${column} IN (${comparator.in.map((v) => params.add(v)).join(", ")})`);
  }
  if (comparator.gte != null) clauses.push(`${column} >= ${params.add(comparator.gte)}`);
  if (comparator.lte != null) clauses.push(`${column} <= ${params.add(comparator.lte)}`);
  return clauses;
}

function dateTimeClauses(
  column: string,
  comparator: DateTimeComparator,
  params: ParamSink,
): string[] {
  const validate = (value: string): string => {
    parseDateTime(value, column);
    return value;
  };
  const clauses: string[] = [];
  if (comparator.eq != null) clauses.push(`${column} = ${params.add(validate(comparator.eq))}`);
  if (comparator.neq != null) clauses.push(`${column} != ${params.add(validate(comparator.neq))}`);
  if (comparator.in?.length) {
    clauses.push(
      `${column} IN (${comparator.in.map((value) => params.add(validate(value))).join(", ")})`,
    );
  }
  if (comparator.nin?.length) {
    clauses.push(
      `${column} NOT IN (${comparator.nin.map((value) => params.add(validate(value))).join(", ")})`,
    );
  }
  if (comparator.gte != null) clauses.push(`${column} >= ${params.add(validate(comparator.gte))}`);
  if (comparator.lte != null) clauses.push(`${column} <= ${params.add(validate(comparator.lte))}`);
  if (comparator.null === true) clauses.push(`${column} IS NULL`);
  if (comparator.null === false) clauses.push(`${column} IS NOT NULL`);
  return clauses;
}

/**
 * Sanitiza la query FTS: cada término entre comillas, unidos con AND implícito.
 * Se agrega `*` para búsqueda por prefijo, de modo que "webhook" encuentre
 * "webhooks" (FTS5 no hace stemming). Los términos entrecomillados por el
 * usuario se respetan como frase exacta, sin prefijo.
 */
export function ftsQuery(search: string): string {
  // Separa frases entre comillas ("foo bar") del resto de los términos.
  const phrases = [...search.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  const rest = search.replace(/"[^"]*"/g, " ");

  const exact = phrases.map((phrase) => `"${phrase.replaceAll('"', '""')}"`);
  const prefixes = rest
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"*`);

  return [...exact, ...prefixes].join(" ");
}

export interface IssueFilterSqlOptions {
  /** Permite a un backend sustituir el predicado FTS sin cambiar el contrato público. */
  searchClause?: (search: string, params: ParamSink) => string;
  /** Actor autenticado para el filtro subscribed. */
  subscriberId?: string | null;
  /** Alcance de Workspace para subconsultas derivadas de SQLite. */
  workspaceId?: string | null;
}

function workspacePredicate(
  table: string,
  workspaceId: string | null | undefined,
  params: ParamSink,
): string {
  return workspaceId
    ? ` AND (${table}.workspace_id = ${params.add(workspaceId)} OR (${table}.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1))`
    : "";
}

export function buildIssueFilter(
  filter: IssueFilter,
  params: ParamSink,
  options: IssueFilterSqlOptions = {},
): string {
  const clauses: string[] = [];

  if (filter.team) clauses.push(...idClauses("issues.team_id", filter.team, params));
  if (filter.state) clauses.push(...idClauses("issues.state_id", filter.state, params));
  if (filter.assignee) clauses.push(...idClauses("issues.assignee_id", filter.assignee, params));
  if (filter.creator) clauses.push(...idClauses("issues.creator_id", filter.creator, params));
  if (filter.project) clauses.push(...idClauses("issues.project_id", filter.project, params));
  if (filter.milestone) clauses.push(...idClauses("issues.milestone_id", filter.milestone, params));
  if (filter.cycle) clauses.push(...idClauses("issues.cycle_id", filter.cycle, params));
  if (filter.parent) clauses.push(...idClauses("issues.parent_id", filter.parent, params));
  if (filter.priority) clauses.push(...intClauses("issues.priority", filter.priority, params));
  if (filter.dueDate) clauses.push(...dateTimeClauses("issues.due_date", filter.dueDate, params));
  if (filter.startedAt)
    clauses.push(...dateTimeClauses("issues.started_at", filter.startedAt, params));
  if (filter.completedAt)
    clauses.push(...dateTimeClauses("issues.completed_at", filter.completedAt, params));
  if (filter.canceledAt)
    clauses.push(...dateTimeClauses("issues.canceled_at", filter.canceledAt, params));

  if (filter.stateType?.eq) {
    clauses.push(
      `issues.state_id IN (SELECT id FROM workflow_states WHERE type = ${params.add(filter.stateType.eq)}${workspacePredicate("workflow_states", options.workspaceId, params)})`,
    );
  }
  if (filter.stateType?.in?.length) {
    const list = filter.stateType.in.map((v) => params.add(v)).join(", ");
    clauses.push(
      `issues.state_id IN (SELECT id FROM workflow_states WHERE type IN (${list})${workspacePredicate("workflow_states", options.workspaceId, params)})`,
    );
  }

  if (filter.labels?.includes) {
    const labelId = params.add(filter.labels.includes);
    clauses.push(
      `issues.id IN (SELECT issue_labels.issue_id FROM issue_labels JOIN labels ON labels.id = issue_labels.label_id WHERE issue_labels.label_id = ${labelId}${workspacePredicate("issue_labels", options.workspaceId, params)}${workspacePredicate("labels", options.workspaceId, params)})`,
    );
  }
  for (const labelId of filter.labels?.includesAll ?? []) {
    const labelParameter = params.add(labelId);
    clauses.push(
      `issues.id IN (SELECT issue_labels.issue_id FROM issue_labels JOIN labels ON labels.id = issue_labels.label_id WHERE issue_labels.label_id = ${labelParameter}${workspacePredicate("issue_labels", options.workspaceId, params)}${workspacePredicate("labels", options.workspaceId, params)})`,
    );
  }

  if (filter.unblocked != null) {
    // Bloqueante abierto: origen de una arista blocks hacia este issue, cuyo
    // estado no es completed/canceled. Los bloqueantes archivados no cuentan.
    const relationWorkspace = workspacePredicate("issue_relations", options.workspaceId, params);
    const blockerWorkspace = workspacePredicate("blockers", options.workspaceId, params);
    const blockerStateWorkspace = workspacePredicate("blocker_states", options.workspaceId, params);
    const openBlocker = `EXISTS (
      SELECT 1 FROM issue_relations
      JOIN issues AS blockers ON blockers.id = issue_relations.issue_id
      JOIN workflow_states AS blocker_states ON blocker_states.id = blockers.state_id
      WHERE issue_relations.type = 'blocks'
        AND issue_relations.related_id = issues.id
        AND blockers.archived_at IS NULL
        AND blocker_states.type NOT IN ('completed', 'canceled')
        ${relationWorkspace}${blockerWorkspace}${blockerStateWorkspace}
    )`;
    if (filter.unblocked) {
      clauses.push(
        `issues.state_id IN (SELECT id FROM workflow_states WHERE type NOT IN ('completed', 'canceled')${workspacePredicate("workflow_states", options.workspaceId, params)})`,
      );
      clauses.push(`NOT ${openBlocker}`);
    } else {
      clauses.push(openBlocker);
    }
  }

  if (filter.subscribed != null) {
    if (!options.subscriberId) {
      clauses.push(filter.subscribed ? "1 = 0" : "1 = 1");
    } else {
      const membership = `EXISTS (SELECT 1 FROM issue_subscribers WHERE issue_subscribers.issue_id = issues.id AND issue_subscribers.actor_id = ${params.add(options.subscriberId)}${workspacePredicate("issue_subscribers", options.workspaceId, params)})`;
      clauses.push(filter.subscribed ? membership : `NOT ${membership}`);
    }
  }

  if (filter.search?.trim()) {
    // Una frase vacía (p. ej. `""`) significa búsqueda ignorada; `*` y las
    // comillas sin cerrar se conservan como tokens literales sin invocar sintaxis FTS5.
    if (options.searchClause) {
      clauses.push(options.searchClause(filter.search, params));
    } else {
      const query = ftsQuery(filter.search);
      if (query) {
        clauses.push(
          `(issues.rowid IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ${params.add(query)})
            OR issues.id IN (SELECT comments.issue_id FROM comments
              JOIN comments_fts ON comments_fts.rowid = comments.rowid
              WHERE comments_fts MATCH ${params.add(query)}${workspacePredicate("comments", options.workspaceId, params)}))`,
        );
      }
    }
  }

  for (const sub of filter.and ?? []) {
    clauses.push(buildIssueFilter(sub, params, options));
  }
  if (filter.or?.length) {
    const branches = filter.or.map((sub) => buildIssueFilter(sub, params, options));
    clauses.push(`(${branches.join(" OR ")})`);
  }

  return clauses.length > 0 ? `(${clauses.join(" AND ")})` : "1=1";
}

// ---- orden y cursores ----

export type IssueOrder =
  | "CREATED_ASC"
  | "CREATED_DESC"
  | "UPDATED_ASC"
  | "UPDATED_DESC"
  | "DUE_DATE_ASC"
  | "DUE_DATE_DESC"
  | "STARTED_AT_ASC"
  | "STARTED_AT_DESC"
  | "COMPLETED_AT_ASC"
  | "COMPLETED_AT_DESC"
  | "CANCELED_AT_ASC"
  | "CANCELED_AT_DESC";

export const ORDER_COLUMNS: Record<IssueOrder, { column: string; direction: "ASC" | "DESC" }> = {
  CREATED_ASC: { column: "issues.created_at", direction: "ASC" },
  CREATED_DESC: { column: "issues.created_at", direction: "DESC" },
  UPDATED_ASC: { column: "issues.updated_at", direction: "ASC" },
  UPDATED_DESC: { column: "issues.updated_at", direction: "DESC" },
  DUE_DATE_ASC: { column: "issues.due_date", direction: "ASC" },
  DUE_DATE_DESC: { column: "issues.due_date", direction: "DESC" },
  STARTED_AT_ASC: { column: "issues.started_at", direction: "ASC" },
  STARTED_AT_DESC: { column: "issues.started_at", direction: "DESC" },
  COMPLETED_AT_ASC: { column: "issues.completed_at", direction: "ASC" },
  COMPLETED_AT_DESC: { column: "issues.completed_at", direction: "DESC" },
  CANCELED_AT_ASC: { column: "issues.canceled_at", direction: "ASC" },
  CANCELED_AT_DESC: { column: "issues.canceled_at", direction: "DESC" },
};

/** Cursor predicate matching SQL's ASC NULLS FIRST / DESC NULLS LAST ordering. */
export function issueCursorClause(
  column: string,
  direction: "ASC" | "DESC",
  orderValue: string | null,
  id: string,
  params: ParamSink,
): string {
  const idParameter = params.add(id);
  if (orderValue === null) {
    return direction === "ASC"
      ? `(${column} IS NOT NULL OR (${column} IS NULL AND issues.id > ${idParameter}))`
      : `(${column} IS NULL AND issues.id < ${idParameter})`;
  }
  const valueParameter = params.add(orderValue);
  return direction === "ASC"
    ? `(${column} > ${valueParameter} OR (${column} = ${valueParameter} AND issues.id > ${idParameter}))`
    : `(${column} IS NULL OR ${column} < ${valueParameter} OR (${column} = ${valueParameter} AND issues.id < ${idParameter}))`;
}

export interface IssueCursor {
  orderValue: string | null;
  id: string;
  orderBy: IssueOrder;
}

export function encodeCursor(orderValue: string | null, id: string, orderBy: IssueOrder): string {
  return Buffer.from(JSON.stringify([orderValue, id, orderBy])).toString("base64url");
}

export function decodeCursor(cursor: string): IssueCursor | null {
  try {
    // Buffer acepta caracteres/base64 incompletos silenciosamente; exigir el
    // round-trip evita que cursores truncados se conviertan en otra entrada.
    if (Buffer.from(cursor, "base64url").toString("base64url") !== cursor) return null;
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      (parsed[0] === null || typeof parsed[0] === "string") &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string" &&
      (parsed[0] === null || parsed[0].length > 0) &&
      parsed[1].length > 0 &&
      parsed[2] in ORDER_COLUMNS
    ) {
      return {
        orderValue: parsed[0] === null ? null : parsed[0],
        id: parsed[1],
        orderBy: parsed[2] as IssueOrder,
      };
    }
  } catch {
    // El resolver convierte un cursor inválido en VALIDATION_FAILED.
  }
  return null;
}
