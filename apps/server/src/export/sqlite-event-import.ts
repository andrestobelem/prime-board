import type { Database } from "bun:sqlite";
import { EventLogWriter, type DomainEvent } from "./event-log.ts";
import {
  areActivityEventsEquivalent,
  activityToDomainEvent,
  type ActivityEventRow,
} from "./activity-stream.ts";
import {
  normalizeSqliteResultRow,
  quoteSqliteIdentifier,
  sqliteColumnName,
  sqliteColumnNames,
  type SQLiteColumnLookup,
} from "./sqlite-row.ts";

export interface SQLiteEventImportOptions {
  readonly db: Database;
  readonly rootDir: string;
  readonly dryRun?: boolean;
  /** Alcance explícito de Workspace para una fuente SQLite multi-Workspace. */
  readonly workspaceId?: string;
}

export interface SQLiteEventImportResult {
  readonly status: "completed";
  readonly scanned: number;
  readonly emitted: number;
  readonly duplicates: number;
  readonly orphaned: number;
  readonly outOfScope: number;
  readonly rejected: number;
  readonly ambiguous: number;
  readonly warnings: readonly string[];
}

interface ActivityRow {
  readonly id: string;
  readonly issue_identifier: string | null;
  readonly actor_id: string | null;
  readonly actor: string | null;
  readonly issue_id: string | null;
  readonly team_id: string | null;
  readonly activity_workspace_id: string | null;
  readonly issue_workspace_id: string | null;
  readonly team_workspace_id: string | null;
  readonly type: string;
  readonly payload: string;
  readonly occurred_at: string;
}

interface ResolvedTable {
  readonly canonicalName: string;
  readonly physicalName: string;
}

interface ImportScope {
  readonly workspaceId: string | undefined;
  readonly workspaceIds: ReadonlySet<string>;
  readonly multipleWorkspaces: boolean;
  readonly activityHasWorkspace: boolean;
  readonly issueHasWorkspace: boolean;
  readonly teamHasWorkspace: boolean;
  readonly activityWorkspaceColumn: string | undefined;
  readonly issueWorkspaceColumn: string | undefined;
  readonly teamWorkspaceColumn: string | undefined;
  readonly ambiguousTables: readonly string[];
  readonly activityTable: ResolvedTable | undefined;
  readonly issueTable: ResolvedTable | undefined;
  readonly teamTable: ResolvedTable | undefined;
  readonly actorTable: ResolvedTable | undefined;
  readonly actorWorkspaceIds: ReadonlyMap<string, ReadonlySet<string>>;
}

function warning(warnings: string[], kind: string, id: string): void {
  if (warnings.length < 100) warnings.push(`${kind}:${id}`);
}

function resolveTable(db: Database, canonicalName: string): ResolvedTable | undefined {
  const row = normalizeSqliteResultRow(
    db
      .query(
        "SELECT name AS name FROM sqlite_master WHERE type = 'table' AND name COLLATE NOCASE = ?1 LIMIT 1",
      )
      .get(canonicalName),
  );
  return typeof row?.name === "string" ? { canonicalName, physicalName: row.name } : undefined;
}

function hasTable(db: Database, table: string): boolean {
  return resolveTable(db, table) !== undefined;
}

function physicalNameFor(db: Database, table: string | ResolvedTable): string | undefined {
  return typeof table === "string" ? resolveTable(db, table)?.physicalName : table.physicalName;
}

function columnLookup(
  db: Database,
  table: string | ResolvedTable,
  column: string,
): SQLiteColumnLookup {
  const physicalName = physicalNameFor(db, table);
  if (physicalName === undefined) return { kind: "missing" };
  return sqliteColumnName(db, physicalName, column);
}

function foundColumn(lookup: SQLiteColumnLookup): string | undefined {
  return lookup.kind === "found" ? lookup.name : undefined;
}

function isAmbiguousColumn(lookup: SQLiteColumnLookup): boolean {
  return lookup.kind === "ambiguous" || lookup.kind === "invalid";
}

function hasAmbiguousTableMetadata(db: Database, table: ResolvedTable | undefined): boolean {
  if (table === undefined) return false;
  const metadata = sqliteColumnNames(db, table.physicalName);
  return metadata.kind === "ambiguous" || metadata.kind === "invalid";
}
function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function nullableTextValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return textValue(value);
}

function normalizedActivityRow(value: unknown): ActivityRow | undefined {
  const row = normalizeSqliteResultRow(value);
  if (row === undefined) return undefined;
  const id = textValue(row.id);
  const type = typeof row.type === "string" ? row.type : undefined;
  const payload = typeof row.payload === "string" ? row.payload : undefined;
  const occurredAt = typeof row.occurred_at === "string" ? row.occurred_at : undefined;
  const issueIdentifier = nullableTextValue(row.issue_identifier);
  const actorId = nullableTextValue(row.actor_id);
  const actor = nullableTextValue(row.actor);
  const issueId = nullableTextValue(row.issue_id);
  const teamId = nullableTextValue(row.team_id);
  const activityWorkspaceId = nullableTextValue(row.activity_workspace_id);
  const issueWorkspaceId = nullableTextValue(row.issue_workspace_id);
  const teamWorkspaceId = nullableTextValue(row.team_workspace_id);
  if (
    id === undefined ||
    type === undefined ||
    payload === undefined ||
    occurredAt === undefined ||
    issueIdentifier === undefined ||
    actorId === undefined ||
    actor === undefined ||
    issueId === undefined ||
    teamId === undefined ||
    activityWorkspaceId === undefined ||
    issueWorkspaceId === undefined ||
    teamWorkspaceId === undefined
  ) {
    return undefined;
  }
  return {
    id,
    issue_identifier: issueIdentifier,
    actor_id: actorId,
    actor,
    issue_id: issueId,
    team_id: teamId,
    activity_workspace_id: activityWorkspaceId,
    issue_workspace_id: issueWorkspaceId,
    team_workspace_id: teamWorkspaceId,
    type,
    payload,
    occurred_at: occurredAt,
  };
}

function actorWorkspaceIndexes(
  db: Database,
  membershipsTable: ResolvedTable | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (membershipsTable === undefined) return new Map();
  const actorLookup = sqliteColumnName(db, membershipsTable.physicalName, "actor_id");
  const workspaceLookup = sqliteColumnName(db, membershipsTable.physicalName, "workspace_id");
  if (actorLookup.kind === "ambiguous" || workspaceLookup.kind === "ambiguous") {
    throw new Error("SQLite event import rejected ambiguous workspace membership columns");
  }
  if (actorLookup.kind === "invalid" || workspaceLookup.kind === "invalid") {
    throw new Error("SQLite event import rejected invalid workspace membership metadata");
  }
  if (actorLookup.kind === "missing" || workspaceLookup.kind === "missing") return new Map();
  const rows = db
    .query(
      `SELECT ${quoteSqliteIdentifier(actorLookup.name)} AS actor_id, ${quoteSqliteIdentifier(workspaceLookup.name)} AS workspace_id FROM ${quoteSqliteIdentifier(membershipsTable.physicalName)}`,
    )
    .all() as unknown[];
  const result = new Map<string, Set<string>>();
  for (const value of rows) {
    const row = normalizeSqliteResultRow(value);
    if (row === undefined) {
      throw new Error("SQLite event import rejected a malformed workspace membership row");
    }
    const actorId = textValue(row.actor_id);
    const workspaceId = textValue(row.workspace_id);
    if (actorId === undefined || workspaceId === undefined) continue;
    const workspaces = result.get(actorId) ?? new Set<string>();
    workspaces.add(workspaceId);
    result.set(actorId, workspaces);
  }
  return result;
}

function validateRequestedWorkspace(workspaceId: string | undefined): void {
  if (
    workspaceId !== undefined &&
    (workspaceId.trim().length === 0 || /[\r\n]/u.test(workspaceId))
  ) {
    throw new Error("SQLite event import workspaceId must be a non-empty safe string");
  }
}

function resolveImportScope(db: Database, requestedWorkspaceId: string | undefined): ImportScope {
  validateRequestedWorkspace(requestedWorkspaceId);
  const workspaceTable = resolveTable(db, "workspace");
  const activityTable = resolveTable(db, "activity");
  const issueTable = resolveTable(db, "issues");
  const teamTable = resolveTable(db, "teams");
  const actorTable = resolveTable(db, "actors");
  const membershipsTable = resolveTable(db, "workspace_memberships");
  if (requestedWorkspaceId !== undefined && workspaceTable === undefined) {
    throw new Error("SQLite event import workspaceId requires a workspace table");
  }

  const workspaceIds: string[] = [];
  if (workspaceTable !== undefined) {
    const idLookup = sqliteColumnName(db, workspaceTable.physicalName, "id");
    if (idLookup.kind === "ambiguous") {
      throw new Error("SQLite event import rejected an ambiguous Workspace ID column");
    }
    if (idLookup.kind === "invalid") {
      throw new Error("SQLite event import rejected invalid Workspace column metadata");
    }
    if (idLookup.kind === "missing") {
      throw new Error("SQLite event import Workspace table requires an id column");
    }
    const idColumn = idLookup.name;
    const values = db
      .query(
        `SELECT ${quoteSqliteIdentifier(idColumn)} AS id FROM ${quoteSqliteIdentifier(workspaceTable.physicalName)} ORDER BY ${quoteSqliteIdentifier(idColumn)}`,
      )
      .all() as unknown[];
    for (const value of values) {
      const row = normalizeSqliteResultRow(value);
      const id = textValue(row?.id);
      if (row === undefined || id === undefined) {
        throw new Error("SQLite event import rejected a malformed Workspace row");
      }
      workspaceIds.push(id);
    }
  }
  if (workspaceTable !== undefined && workspaceIds.length === 0) {
    throw new Error("SQLite event import requires at least one Workspace");
  }
  const multipleWorkspaces = workspaceIds.length > 1;
  if (multipleWorkspaces && requestedWorkspaceId === undefined) {
    throw new Error(
      "SQLite event import requires workspaceId when the source contains multiple Workspaces",
    );
  }
  if (requestedWorkspaceId !== undefined && !workspaceIds.includes(requestedWorkspaceId)) {
    throw new Error(`SQLite event import Workspace ${requestedWorkspaceId} does not exist`);
  }

  const activityWorkspaceLookup = columnLookup(db, activityTable ?? "activity", "workspace_id");
  const issueWorkspaceLookup = columnLookup(db, issueTable ?? "issues", "workspace_id");
  const teamWorkspaceLookup = columnLookup(db, teamTable ?? "teams", "workspace_id");
  const workspaceColumnLookups = [
    ["activity", activityWorkspaceLookup],
    ["issues", issueWorkspaceLookup],
    ["teams", teamWorkspaceLookup],
  ] as const;
  const scopedTables = [
    ["activity", activityTable],
    ["issues", issueTable],
    ["teams", teamTable],
    ["actors", actorTable],
  ] as const;
  const ambiguousTables: string[] = scopedTables
    .filter(([, table]) => hasAmbiguousTableMetadata(db, table))
    .map(([table]) => table);
  for (const [table, lookup] of workspaceColumnLookups) {
    if (isAmbiguousColumn(lookup) && !ambiguousTables.includes(table)) {
      ambiguousTables.push(table);
    }
  }
  if (multipleWorkspaces && ambiguousTables.length > 0) {
    throw new Error(
      `SQLite event import rejected ambiguous column metadata on ${ambiguousTables.join(", ")}`,
    );
  }
  if (
    multipleWorkspaces &&
    workspaceColumnLookups.some(([, lookup]) => lookup.kind === "missing")
  ) {
    throw new Error(
      "SQLite event import cannot scope a multi-Workspace source without workspace_id on activity, issues, and teams",
    );
  }

  if (
    hasAmbiguousTableMetadata(db, membershipsTable) &&
    !ambiguousTables.includes("workspace_memberships")
  ) {
    ambiguousTables.push("workspace_memberships");
  }
  const uniqueAmbiguousTables = [...new Set(ambiguousTables)];

  return {
    workspaceId: requestedWorkspaceId ?? workspaceIds[0],
    workspaceIds: new Set(workspaceIds),
    multipleWorkspaces,
    activityHasWorkspace: activityWorkspaceLookup.kind === "found",
    issueHasWorkspace: issueWorkspaceLookup.kind === "found",
    teamHasWorkspace: teamWorkspaceLookup.kind === "found",
    activityWorkspaceColumn: foundColumn(activityWorkspaceLookup),
    issueWorkspaceColumn: foundColumn(issueWorkspaceLookup),
    teamWorkspaceColumn: foundColumn(teamWorkspaceLookup),
    ambiguousTables: uniqueAmbiguousTables,
    activityTable,
    issueTable,
    teamTable,
    actorTable,
    actorWorkspaceIds:
      uniqueAmbiguousTables.length > 0 ? new Map() : actorWorkspaceIndexes(db, membershipsTable),
  };
}

function qualifiedColumn(table: string, column: string | undefined): string {
  if (column === undefined) {
    throw new Error(`SQLite event import requires a resolved ${table} column`);
  }
  return `${table}.${quoteSqliteIdentifier(column)}`;
}

function activityQuery(scope: ImportScope): string {
  if (
    scope.activityTable === undefined ||
    scope.issueTable === undefined ||
    scope.teamTable === undefined ||
    scope.actorTable === undefined
  ) {
    throw new Error("SQLite event import requires Activity, Issue, Team, and Actor tables");
  }
  const activityTable = quoteSqliteIdentifier(scope.activityTable.physicalName);
  const issueTable = quoteSqliteIdentifier(scope.issueTable.physicalName);
  const teamTable = quoteSqliteIdentifier(scope.teamTable.physicalName);
  const actorTable = quoteSqliteIdentifier(scope.actorTable.physicalName);
  const activityWorkspaceReference = scope.activityHasWorkspace
    ? qualifiedColumn("activity", scope.activityWorkspaceColumn)
    : "NULL";
  const issueWorkspaceReference = scope.issueHasWorkspace
    ? qualifiedColumn("issues", scope.issueWorkspaceColumn)
    : "NULL";
  const teamWorkspaceReference = scope.teamHasWorkspace
    ? qualifiedColumn("teams", scope.teamWorkspaceColumn)
    : "NULL";
  const activityWorkspace = scope.activityHasWorkspace
    ? `${activityWorkspaceReference} AS activity_workspace_id`
    : "NULL AS activity_workspace_id";
  const issueWorkspace = scope.issueHasWorkspace
    ? `${issueWorkspaceReference} AS issue_workspace_id`
    : "NULL AS issue_workspace_id";
  const teamWorkspace = scope.teamHasWorkspace
    ? `${teamWorkspaceReference} AS team_workspace_id`
    : "NULL AS team_workspace_id";
  const issueJoin =
    scope.activityHasWorkspace && scope.issueHasWorkspace
      ? scope.multipleWorkspaces
        ? `LEFT JOIN ${issueTable} AS issues ON issues.id = activity.issue_id AND ${activityWorkspaceReference} IS NOT NULL AND ${issueWorkspaceReference} = ${activityWorkspaceReference}`
        : `LEFT JOIN ${issueTable} AS issues ON issues.id = activity.issue_id AND (${activityWorkspaceReference} IS NULL OR ${issueWorkspaceReference} = ${activityWorkspaceReference})`
      : `LEFT JOIN ${issueTable} AS issues ON issues.id = activity.issue_id`;
  const teamJoin =
    scope.issueHasWorkspace && scope.teamHasWorkspace
      ? scope.multipleWorkspaces
        ? `LEFT JOIN ${teamTable} AS teams ON teams.id = issues.team_id AND ${issueWorkspaceReference} IS NOT NULL AND ${teamWorkspaceReference} = ${issueWorkspaceReference}`
        : `LEFT JOIN ${teamTable} AS teams ON teams.id = issues.team_id AND (${issueWorkspaceReference} IS NULL OR ${teamWorkspaceReference} = ${issueWorkspaceReference})`
      : `LEFT JOIN ${teamTable} AS teams ON teams.id = issues.team_id`;
  return `SELECT activity.id AS id,
                 teams.key || '-' || issues.number AS issue_identifier,
                 actors.id AS actor_id,
                 actors.name AS actor,
                 issues.id AS issue_id,
                 teams.id AS team_id,
                 ${activityWorkspace},
                 ${issueWorkspace},
                 ${teamWorkspace},
                 activity.type AS type,
                 activity.payload AS payload,
                 activity.created_at AS occurred_at
          FROM ${activityTable} AS activity
          ${issueJoin}
          ${teamJoin}
          LEFT JOIN ${actorTable} AS actors ON actors.id = activity.actor_id
          ORDER BY activity.created_at, activity.id`;
}

function tableRowCount(db: Database, table: ResolvedTable | undefined): number {
  if (table === undefined) return 0;
  const row = normalizeSqliteResultRow(
    db.query(`SELECT count(*) AS count FROM ${quoteSqliteIdentifier(table.physicalName)}`).get(),
  );
  const count = row?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("SQLite event import rejected malformed Activity table count");
  }
  return count;
}

function ambiguousImportResult(db: Database, scope: ImportScope): SQLiteEventImportResult {
  const scanned = tableRowCount(db, scope.activityTable);
  return {
    status: "completed",
    scanned,
    emitted: 0,
    duplicates: 0,
    orphaned: 0,
    outOfScope: 0,
    rejected: 0,
    ambiguous: scanned,
    warnings: scope.ambiguousTables.slice(0, 100).map((table) => `ambiguous:${table}`),
  };
}

/**
 * Importa la historia durable disponible en Activity de SQLite al stream
 * canónico. No lee logs históricos por Issue ni se conecta a PostgreSQL.
 * Una fuente multi-Workspace siempre exige un selector explícito de Workspace.
 */
export function importSqliteActivity(options: SQLiteEventImportOptions): SQLiteEventImportResult {
  const scope = resolveImportScope(options.db, options.workspaceId);
  if (scope.ambiguousTables.length > 0) {
    return ambiguousImportResult(options.db, scope);
  }
  if (!hasTable(options.db, "activity")) {
    return {
      status: "completed",
      scanned: 0,
      emitted: 0,
      duplicates: 0,
      orphaned: 0,
      outOfScope: 0,
      rejected: 0,
      ambiguous: 0,
      warnings: [],
    };
  }
  const missingTables = ["issues", "teams", "actors"].filter(
    (table) => !hasTable(options.db, table),
  );
  if (missingTables.length > 0) {
    const activityTable = scope.activityTable;
    if (activityTable === undefined) throw new Error("SQLite event import requires Activity table");
    const values = options.db
      .query(`SELECT "id" AS id FROM ${quoteSqliteIdentifier(activityTable.physicalName)}`)
      .all() as unknown[];
    const ids = values.map((value) => {
      const row = normalizeSqliteResultRow(value);
      return textValue(row?.id) ?? "unknown";
    });
    return {
      status: "completed",
      scanned: values.length,
      emitted: 0,
      duplicates: 0,
      orphaned: values.length,
      outOfScope: 0,
      rejected: 0,
      ambiguous: 0,
      warnings: ids.slice(0, 100).map((id) => `orphaned:activity:${id}`),
    };
  }
  const values = options.db.query(activityQuery(scope)).all() as unknown[];
  const rows = values.map(normalizedActivityRow);

  const writer = new EventLogWriter({ rootDir: options.rootDir });
  const warnings: string[] = [];
  // Solo una importación real puede reparar un tail truncado; el dry-run no
  // debe modificar el Log y falla cerrado si el stream no es legible.
  if (!options.dryRun) writer.recover();
  // El dry-run inspecciona el stream existente. Nunca crea el archivo, pero
  // informa los mismos duplicados y conflictos que una importación real.
  const existing = new Map(writer.read().map((event) => [event.eventId, event]));
  const seen = new Map<string, DomainEvent>();
  const events: DomainEvent[] = [];
  let orphaned = 0;
  let outOfScope = 0;
  let rejected = 0;
  let ambiguous = 0;
  let duplicates = 0;

  for (const row of rows) {
    if (row === undefined) {
      rejected += 1;
      warning(warnings, "rejected", "unknown");
      continue;
    }
    const rowWorkspaceId =
      row.activity_workspace_id ?? row.issue_workspace_id ?? row.team_workspace_id;
    if (rowWorkspaceId !== undefined && rowWorkspaceId !== null) {
      if (!scope.workspaceIds.has(rowWorkspaceId)) {
        orphaned += 1;
        warning(warnings, "orphaned", row.id);
        continue;
      }
      if (scope.workspaceId !== undefined && rowWorkspaceId !== scope.workspaceId) {
        outOfScope += 1;
        warning(warnings, "out_of_scope", row.id);
        continue;
      }
    }
    if (scope.multipleWorkspaces && row.activity_workspace_id == null) {
      orphaned += 1;
      warning(warnings, "orphaned", row.id);
      continue;
    }

    const actorWorkspaces = row.actor_id ? scope.actorWorkspaceIds.get(row.actor_id) : undefined;
    if (actorWorkspaces !== undefined && actorWorkspaces.size > 0) {
      const directActivityWorkspace = row.activity_workspace_id !== null;
      const derivedWorkspace =
        rowWorkspaceId !== null && rowWorkspaceId !== undefined && !directActivityWorkspace;
      // El importador completo trata el scope directo de Activity como autoridad,
      // pero combina Membership con el scope heredado de un padre o de un esquema
      // legacy. Conserva esa distinción para impedir un cruce entre Workspaces.
      if (directActivityWorkspace) {
        if (rowWorkspaceId === null || !actorWorkspaces.has(rowWorkspaceId)) {
          orphaned += 1;
          warning(warnings, "orphaned", row.id);
          continue;
        }
      } else if (derivedWorkspace) {
        if (actorWorkspaces.size > 1 || !actorWorkspaces.has(rowWorkspaceId)) {
          ambiguous += 1;
          warning(warnings, "ambiguous", row.id);
          continue;
        }
      } else if (actorWorkspaces.size > 1) {
        ambiguous += 1;
        warning(warnings, "ambiguous", row.id);
        continue;
      } else if (scope.workspaceId !== undefined && !actorWorkspaces.has(scope.workspaceId)) {
        outOfScope += 1;
        warning(warnings, "out_of_scope", row.id);
        continue;
      }
    }

    const actor = row.actor_id ?? row.actor;
    if (!row.issue_identifier || !actor || !row.issue_id || !row.team_id) {
      orphaned += 1;
      warning(warnings, "orphaned", row.id);
      continue;
    }
    // Un schema legacy singleton tiene un Workspace inequívoco aunque sus filas
    // sean anteriores a workspace_id. Esto alinea el importador completo sin
    // inferir un scope en una fuente multi-Workspace.
    const eventWorkspaceId =
      rowWorkspaceId ?? (scope.multipleWorkspaces ? undefined : scope.workspaceId);
    const event = activityToDomainEvent({
      id: row.id,
      issue_identifier: row.issue_identifier,
      issue_id: row.issue_id ?? undefined,
      actor_id: row.actor_id ?? undefined,
      actor,
      type: row.type,
      payload: row.payload,
      workspace_id: eventWorkspaceId,
      occurred_at: row.occurred_at,
    } satisfies ActivityEventRow);
    if (!event) {
      rejected += 1;
      warning(warnings, "rejected", row.id);
      continue;
    }
    const previous = seen.get(event.eventId) ?? existing.get(event.eventId);
    if (previous) {
      if (!areActivityEventsEquivalent(previous, event)) {
        ambiguous += 1;
        warning(warnings, "ambiguous", event.eventId);
      } else {
        duplicates += 1;
      }
      continue;
    }
    seen.set(event.eventId, event);
    events.push(event);
  }

  if (!options.dryRun) {
    for (const event of events) writer.append(event);
  }
  return {
    status: "completed",
    scanned: rows.length,
    emitted: events.length,
    duplicates,
    orphaned,
    outOfScope,
    rejected,
    ambiguous,
    warnings,
  };
}
// El importador completo vive en otro módulo para mantener compatible esta API
// de Activity con RepoSync y los callers existentes.
export {
  importSqliteCanonicalEvents,
  importSqliteEventLog,
  importSqliteHistory,
  SQLITE_HISTORY_EXCLUDED_TABLES,
  SQLITE_HISTORY_TABLES,
} from "./sqlite-history-import.ts";
export type {
  SQLiteHistoryImportOptions,
  SQLiteHistoryImportResult,
  SQLiteHistoryTableReport,
} from "./sqlite-history-import.ts";
