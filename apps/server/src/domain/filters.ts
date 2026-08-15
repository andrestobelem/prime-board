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
  parent?: IDComparator | null;
  priority?: IntComparator | null;
  labels?: LabelComparator | null;
  /** Full-text sobre título y descripción (FTS5). */
  search?: string | null;
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

export function buildIssueFilter(filter: IssueFilter, params: ParamSink): string {
  const clauses: string[] = [];

  if (filter.team) clauses.push(...idClauses("issues.team_id", filter.team, params));
  if (filter.state) clauses.push(...idClauses("issues.state_id", filter.state, params));
  if (filter.assignee) clauses.push(...idClauses("issues.assignee_id", filter.assignee, params));
  if (filter.creator) clauses.push(...idClauses("issues.creator_id", filter.creator, params));
  if (filter.project) clauses.push(...idClauses("issues.project_id", filter.project, params));
  if (filter.parent) clauses.push(...idClauses("issues.parent_id", filter.parent, params));
  if (filter.priority) clauses.push(...intClauses("issues.priority", filter.priority, params));

  if (filter.stateType?.eq) {
    clauses.push(
      `issues.state_id IN (SELECT id FROM workflow_states WHERE type = ${params.add(filter.stateType.eq)})`,
    );
  }
  if (filter.stateType?.in?.length) {
    const list = filter.stateType.in.map((v) => params.add(v)).join(", ");
    clauses.push(`issues.state_id IN (SELECT id FROM workflow_states WHERE type IN (${list}))`);
  }

  if (filter.labels?.includes) {
    clauses.push(
      `issues.id IN (SELECT issue_id FROM issue_labels WHERE label_id = ${params.add(filter.labels.includes)})`,
    );
  }
  for (const labelId of filter.labels?.includesAll ?? []) {
    clauses.push(
      `issues.id IN (SELECT issue_id FROM issue_labels WHERE label_id = ${params.add(labelId)})`,
    );
  }

  if (filter.search?.trim()) {
    clauses.push(
      `issues.rowid IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ${params.add(ftsQuery(filter.search))})`,
    );
  }

  for (const sub of filter.and ?? []) {
    clauses.push(buildIssueFilter(sub, params));
  }
  if (filter.or?.length) {
    const branches = filter.or.map((sub) => buildIssueFilter(sub, params));
    clauses.push(`(${branches.join(" OR ")})`);
  }

  return clauses.length > 0 ? `(${clauses.join(" AND ")})` : "1=1";
}

// ---- orden y cursores ----

export type IssueOrder = "CREATED_ASC" | "CREATED_DESC" | "UPDATED_ASC" | "UPDATED_DESC";

export const ORDER_COLUMNS: Record<IssueOrder, { column: string; direction: "ASC" | "DESC" }> = {
  CREATED_ASC: { column: "issues.created_at", direction: "ASC" },
  CREATED_DESC: { column: "issues.created_at", direction: "DESC" },
  UPDATED_ASC: { column: "issues.updated_at", direction: "ASC" },
  UPDATED_DESC: { column: "issues.updated_at", direction: "DESC" },
};

export function encodeCursor(orderValue: string, id: string): string {
  return Buffer.from(JSON.stringify([orderValue, id])).toString("base64url");
}

export function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2) {
      return [String(parsed[0]), String(parsed[1])];
    }
  } catch {
    // cursor inválido → se ignora
  }
  return null;
}
