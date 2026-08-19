import type { Persistence } from "../db/persistence.ts";
import { canDiscoverPostgresTeam, listPostgresTeams } from "./postgres-teams.ts";
import {
  buildIssueFilter,
  decodeCursor,
  encodeCursor,
  ORDER_COLUMNS,
  ParamSink,
  type IssueFilter,
  type IssueOrder,
} from "./filters.ts";
import { mapIssue, type IssueRow } from "./issues.ts";
import type { ActorRow, AuthContext } from "../auth/viewer.ts";
import { apiError } from "../graphql/errors.ts";

const SELECT_ISSUE =
  "SELECT issues.*, teams.key AS team_key FROM issues JOIN teams ON teams.id = issues.team_id";

type SqlValue = string | number | boolean | bigint | Uint8Array | null;

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
  persistence: Persistence,
  id: string,
): Promise<IssueRow | null> {
  return persistence.one<IssueRow>(`${SELECT_ISSUE} WHERE issues.id = $1`, [id]);
}

/** Acepta UUID o identificador legible tipo PRB-126. */
export async function getPostgresIssueByRef(
  persistence: Persistence,
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

export { mapIssue };
