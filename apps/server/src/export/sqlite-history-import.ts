import type { Database } from "bun:sqlite";
import {
  areDomainEventsEquivalent,
  CURRENT_EVENT_SCHEMA_VERSION,
  EventLogWriter,
  isSensitiveEventName,
  type DomainEvent,
  type JsonObject,
  type JsonValue,
  validateDomainEvent,
} from "./event-log.ts";
import {
  areActivityEventsEquivalent,
  activityToDomainEvent,
  type ActivityEventRow,
} from "./activity-stream.ts";
import {
  normalizeSqliteResultRow,
  quoteSqliteIdentifier,
  sqliteColumnName,
  type SQLiteColumnLookup,
} from "./sqlite-row.ts";

/** Tablas SQLite compartidas que se pueden representar en el Repository Source. */
export const SQLITE_HISTORY_TABLES = [
  "workspace",
  "actors",
  "workspace_memberships",
  "teams",
  "workflow_states",
  "projects",
  "project_teams",
  "milestones",
  "cycles",
  "issues",
  "labels",
  "issue_labels",
  "issue_relations",
  "comments",
  "activity",
  "team_memberships",
  "initiatives",
  "initiative_projects",
  "initiative_teams",
  "project_updates",
  "reviews",
  "issue_subscribers",
  "saved_views",
] as const;

/** Tablas que nunca se leen como filas porque contienen secretos o estado personal. */
export const SQLITE_HISTORY_EXCLUDED_TABLES = [
  "api_keys",
  "api_key_scopes",
  "api_key_team_limits",
  "api_key_team_limits_restricted",
  "api_key_workspaces",
  "api_key_grants",
  "api_key_hashes",
  "actor_invitations",
  "invitations",
  "grants",
  "hashes",
  "webhooks",
  "favorites",
  "inbox_receipts",
  "documents",
] as const;

type HistoryTable = (typeof SQLITE_HISTORY_TABLES)[number];
type SourceRow = Record<string, unknown>;

type ImportFinding = "emitted" | "duplicate" | "orphaned" | "outOfScope" | "rejected" | "ambiguous";

export interface SQLiteHistoryTableReport {
  /** Nombre canónico usado por el importador y por los metadatos del evento. */
  readonly canonicalName?: string;
  /** Nombre de sqlite_master. Puede cambiar en mayúsculas o contener puntuación. */
  readonly physicalName?: string;
  readonly scanned: number;
  readonly emitted: number;
  readonly duplicates: number;
  readonly orphaned: number;
  readonly outOfScope: number;
  readonly rejected: number;
  readonly ambiguous: number;
  readonly excluded: number;
}

export interface SQLiteHistoryImportOptions {
  readonly db: Database;
  /** Raíz del Repository Source. Solo se escribe `.prime-board/log/events.jsonl`. */
  readonly rootDir: string;
  /** Inspecciona la fuente y el Log existente sin modificar el Log. */
  readonly dryRun?: boolean;
  /** Obligatorio cuando la fuente tiene varios Workspaces. */
  readonly workspaceId?: string;
  /** Máximo de eventos por append. Un reintento puede reiniciar en cualquier lote. */
  readonly batchSize?: number;
  /** Mantiene activo el puente de Activity. Está activo por defecto. */
  readonly includeActivity?: boolean;
  /** Emite las filas actuales como eventos explícitos `snapshot_imported`. */
  readonly includeSnapshots?: boolean;
}

export interface SQLiteHistoryImportResult {
  readonly status: "completed";
  readonly dryRun: boolean;
  readonly workspaceId?: string;
  readonly multipleWorkspaces: boolean;
  /** Todas las filas inspeccionadas, incluidas las excluidas por política. */
  readonly scanned: number;
  /** Eventos que se agregarían o que se agregaron. */
  readonly emitted: number;
  /** Alias de emitted para consumidores de lotes e informes. */
  readonly converted: number;
  readonly written: number;
  readonly batches: number;
  readonly duplicates: number;
  readonly orphaned: number;
  readonly outOfScope: number;
  readonly rejected: number;
  readonly ambiguous: number;
  /** Filas de tablas secretas o personales que no se convierten de forma intencional. */
  readonly excluded: number;
  readonly tables: Readonly<Record<string, SQLiteHistoryTableReport>>;
  /** IDs y nombres de tabla acotados. Nunca incluye payloads ni credenciales. */
  readonly warnings: readonly string[];
}

interface MutableTableReport {
  canonicalName?: string;
  physicalName?: string;
  scanned: number;
  emitted: number;
  duplicates: number;
  orphaned: number;
  outOfScope: number;
  rejected: number;
  ambiguous: number;
  excluded: number;
}

interface ResolvedTable {
  readonly canonicalName: string;
  readonly physicalName: string;
}

interface SourceScope {
  readonly workspaceId: string | undefined;
  readonly multipleWorkspaces: boolean;
  readonly hasWorkspaceTable: boolean;
}

interface RawTable {
  readonly physicalName: string;
  readonly values: readonly unknown[];
  readonly rows: readonly SourceRow[];
  readonly malformed: number;
}

interface RowIdentity {
  readonly table: HistoryTable;
  readonly row: SourceRow;
  readonly sourceId: string;
}

interface RowIndexes {
  readonly byTable: ReadonlyMap<string, ReadonlyMap<string, SourceRow>>;
  readonly workspaceByTable: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly actorWorkspaceIds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly duplicateIdsByTable: ReadonlyMap<string, ReadonlySet<string>>;
}

interface RowScope {
  readonly workspaceId: string | undefined;
  readonly outOfScope: boolean;
  readonly orphaned: boolean;
  readonly ambiguous: boolean;
  readonly rejected: boolean;
}

const COMPOSITE_KEY_FIELDS: Partial<Record<HistoryTable, readonly string[]>> = {
  project_teams: ["project_id", "team_id"],
  issue_labels: ["issue_id", "label_id"],
  initiative_projects: ["initiative_id", "project_id"],
  initiative_teams: ["initiative_id", "team_id"],
  issue_subscribers: ["issue_id", "actor_id"],
};

const AGGREGATE_NAMES: Record<HistoryTable, string> = {
  workspace: "workspace",
  actors: "actor",
  workspace_memberships: "workspace_membership",
  teams: "team",
  workflow_states: "workflow_state",
  projects: "project",
  project_teams: "project_team",
  milestones: "milestone",
  cycles: "cycle",
  issues: "issue",
  labels: "label",
  issue_labels: "issue_label",
  issue_relations: "issue_relation",
  comments: "comment",
  activity: "issue",
  team_memberships: "team_membership",
  initiatives: "initiative",
  initiative_projects: "initiative_project",
  initiative_teams: "initiative_team",
  project_updates: "project_update",
  reviews: "review",
  issue_subscribers: "issue_subscriber",
  saved_views: "saved_view",
};

const REFERENCED_WORKSPACE_FIELDS: Partial<
  Record<HistoryTable, ReadonlyArray<readonly [string, HistoryTable]>>
> = {
  actors: [["suspended_by", "actors"]],
  teams: [["default_state_id", "workflow_states"]],
  workflow_states: [["team_id", "teams"]],
  projects: [["lead_id", "actors"]],
  project_teams: [
    ["project_id", "projects"],
    ["team_id", "teams"],
  ],
  milestones: [["project_id", "projects"]],
  cycles: [["team_id", "teams"]],
  issues: [
    ["team_id", "teams"],
    ["state_id", "workflow_states"],
    ["parent_id", "issues"],
    ["project_id", "projects"],
    ["milestone_id", "milestones"],
    ["cycle_id", "cycles"],
    ["assignee_id", "actors"],
    ["creator_id", "actors"],
  ],
  labels: [["team_id", "teams"]],
  issue_labels: [
    ["issue_id", "issues"],
    ["label_id", "labels"],
  ],
  issue_relations: [
    ["issue_id", "issues"],
    ["related_id", "issues"],
  ],
  comments: [
    ["issue_id", "issues"],
    ["actor_id", "actors"],
  ],
  activity: [
    ["issue_id", "issues"],
    ["actor_id", "actors"],
  ],
  team_memberships: [
    ["team_id", "teams"],
    ["actor_id", "actors"],
  ],
  initiatives: [["owner_id", "actors"]],
  initiative_projects: [
    ["initiative_id", "initiatives"],
    ["project_id", "projects"],
  ],
  initiative_teams: [
    ["initiative_id", "initiatives"],
    ["team_id", "teams"],
  ],
  project_updates: [
    ["project_id", "projects"],
    ["author_id", "actors"],
  ],
  reviews: [
    ["issue_id", "issues"],
    ["requester_id", "actors"],
    ["reviewer_id", "actors"],
  ],
  issue_subscribers: [
    ["issue_id", "issues"],
    ["actor_id", "actors"],
  ],
  saved_views: [
    ["team_id", "teams"],
    ["owner_id", "actors"],
  ],
  workspace_memberships: [
    ["actor_id", "actors"],
    ["suspended_by", "actors"],
  ],
};

const REQUIRED_REFERENCE_FIELDS: Partial<Record<HistoryTable, ReadonlySet<string>>> = {
  workspace_memberships: new Set(["actor_id"]),
  workflow_states: new Set(["team_id"]),
  project_teams: new Set(["project_id", "team_id"]),
  milestones: new Set(["project_id"]),
  cycles: new Set(["team_id"]),
  issues: new Set(["team_id", "state_id", "creator_id"]),
  issue_labels: new Set(["issue_id", "label_id"]),
  issue_relations: new Set(["issue_id", "related_id"]),
  comments: new Set(["issue_id", "actor_id"]),
  activity: new Set(["issue_id", "actor_id"]),
  team_memberships: new Set(["team_id", "actor_id"]),
  initiative_projects: new Set(["initiative_id", "project_id"]),
  initiative_teams: new Set(["initiative_id", "team_id"]),
  project_updates: new Set(["project_id", "author_id"]),
  reviews: new Set(["issue_id", "requester_id", "reviewer_id"]),
  issue_subscribers: new Set(["issue_id", "actor_id"]),
  saved_views: new Set(["owner_id"]),
};

function isRecord(value: unknown): value is SourceRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(row: SourceRow, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function validateWorkspaceId(workspaceId: string | undefined): void {
  if (
    workspaceId !== undefined &&
    (workspaceId.trim().length === 0 || /[\r\n]/u.test(workspaceId))
  ) {
    throw new Error("SQLite history import workspaceId must be a non-empty safe string");
  }
}

function validateBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
    throw new Error("SQLite history import batchSize must be an integer between 1 and 10000");
  }
  return batchSize;
}

/**
 * Resuelve una tabla lógica desde sqlite_master sin interpolar el nombre
 * solicitado. SQLite compara nombres sin distinguir mayúsculas, pero la forma
 * física sirve para diagnósticos y consultas citadas de forma segura.
 */
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
function isSensitiveTableName(table: string): boolean {
  const compact = table.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  return compact.includes("document") || isSensitiveEventName(table);
}

function canonicalExcludedTableName(table: string): string | undefined {
  const normalized = table.toLowerCase();
  return SQLITE_HISTORY_EXCLUDED_TABLES.find((known) => known.toLowerCase() === normalized);
}

function excludedTableNames(db: Database): readonly ResolvedTable[] {
  // Conserva el nombre canónico de tablas conocidas y el nombre físico de una
  // variante sensible desconocida. Cada consulta usa el nombre físico citado.
  const resolved = new Map<string, ResolvedTable>();
  for (const canonicalName of SQLITE_HISTORY_EXCLUDED_TABLES) {
    const table = resolveTable(db, canonicalName);
    if (table !== undefined) resolved.set(canonicalName.toLowerCase(), table);
  }
  const rows = db
    .query("SELECT name AS name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown[];
  for (const value of rows) {
    const row = normalizeSqliteResultRow(value);
    if (typeof row?.name !== "string") {
      throw new Error("SQLite history import rejected malformed table metadata");
    }
    if (!isSensitiveTableName(row.name)) continue;
    const canonicalName = canonicalExcludedTableName(row.name) ?? row.name;
    const key = canonicalName.toLowerCase();
    if (!resolved.has(key)) {
      resolved.set(key, { canonicalName, physicalName: row.name });
    }
  }
  return [...resolved.values()];
}

function resolveScope(db: Database, requestedWorkspaceId: string | undefined): SourceScope {
  validateWorkspaceId(requestedWorkspaceId);
  const workspaceTable = resolveTable(db, "workspace");
  const hasWorkspaceTable = workspaceTable !== undefined;
  if (requestedWorkspaceId !== undefined && !hasWorkspaceTable) {
    throw new Error("SQLite history import workspaceId requires a workspace table");
  }

  const workspaceIds: string[] = [];
  if (workspaceTable !== undefined) {
    const idLookup = sqliteColumnName(db, workspaceTable.physicalName, "id");
    if (idLookup.kind === "ambiguous") {
      throw new Error("SQLite history import rejected an ambiguous Workspace ID column");
    }
    if (idLookup.kind === "invalid") {
      throw new Error("SQLite history import rejected invalid Workspace column metadata");
    }
    if (idLookup.kind === "missing") {
      throw new Error("SQLite history import Workspace table requires an id column");
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
        throw new Error("SQLite history import rejected a malformed Workspace row");
      }
      workspaceIds.push(id);
    }
  }
  if (hasWorkspaceTable && workspaceIds.length === 0) {
    throw new Error("SQLite history import requires at least one Workspace");
  }
  const multipleWorkspaces = workspaceIds.length > 1;
  if (multipleWorkspaces && requestedWorkspaceId === undefined) {
    throw new Error(
      "SQLite history import requires workspaceId when the source contains multiple Workspaces",
    );
  }
  if (requestedWorkspaceId !== undefined && !workspaceIds.includes(requestedWorkspaceId)) {
    throw new Error(`SQLite history import Workspace ${requestedWorkspaceId} does not exist`);
  }
  // El importador legacy de Activity ya exige estas tres columnas. Mantener el
  // mismo cierre evita que los IDs crucen alcances.
  const workspaceColumns = [
    ["activity", columnLookup(db, "activity", "workspace_id")],
    ["issues", columnLookup(db, "issues", "workspace_id")],
    ["teams", columnLookup(db, "teams", "workspace_id")],
  ] as const;
  const ambiguousWorkspaceColumns = workspaceColumns
    .filter(([, lookup]) => lookup.kind === "ambiguous" || lookup.kind === "invalid")
    .map(([table]) => table);
  if (ambiguousWorkspaceColumns.length > 0) {
    throw new Error(
      `SQLite history import rejected ambiguous column metadata on ${ambiguousWorkspaceColumns.join(", ")}`,
    );
  }
  if (multipleWorkspaces && workspaceColumns.some(([, lookup]) => lookup.kind === "missing")) {
    throw new Error(
      "SQLite history import cannot scope a multi-Workspace source without workspace_id on activity, issues, and teams",
    );
  }

  return {
    workspaceId: requestedWorkspaceId ?? workspaceIds[0],
    multipleWorkspaces,
    hasWorkspaceTable,
  };
}

function readTable(db: Database, table: ResolvedTable): RawTable {
  const values = db
    .query(`SELECT * FROM ${quoteSqliteIdentifier(table.physicalName)}`)
    .all() as unknown[];
  const rows: SourceRow[] = [];
  let malformed = 0;
  for (const value of values) {
    if (!isRecord(value)) {
      malformed += 1;
      continue;
    }
    const normalized = normalizeSqliteResultRow(value);
    if (normalized === undefined) malformed += 1;
    else rows.push(normalized);
  }
  return { physicalName: table.physicalName, values, rows, malformed };
}

function sourceId(table: HistoryTable, row: SourceRow): string | undefined {
  const direct = textValue(row.id);
  if (direct !== undefined) return direct;
  const fields = COMPOSITE_KEY_FIELDS[table];
  if (!fields) return undefined;
  const parts: string[] = [];
  for (const field of fields) {
    const value = textValue(row[field]);
    if (value === undefined) return undefined;
    parts.push(value);
  }
  return JSON.stringify(parts);
}

function mutableReport(): MutableTableReport {
  return {
    scanned: 0,
    emitted: 0,
    duplicates: 0,
    orphaned: 0,
    outOfScope: 0,
    rejected: 0,
    ambiguous: 0,
    excluded: 0,
  };
}

function addFinding(report: MutableTableReport, finding: ImportFinding): void {
  if (finding === "emitted") report.emitted += 1;
  else if (finding === "duplicate") report.duplicates += 1;
  else if (finding === "orphaned") report.orphaned += 1;
  else if (finding === "outOfScope") report.outOfScope += 1;
  else if (finding === "rejected") report.rejected += 1;
  else report.ambiguous += 1;
}

function immutableReports(
  reports: ReadonlyMap<string, MutableTableReport>,
): Readonly<Record<string, SQLiteHistoryTableReport>> {
  return Object.fromEntries(
    [...reports.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, report]) => [table, { ...report }]),
  );
}

function warn(warnings: string[], kind: string, table: string, id?: string): void {
  if (warnings.length >= 100) return;
  warnings.push(id === undefined ? `${kind}:${table}` : `${kind}:${table}:${id}`);
}

function tableRows(db: Database, reports: Map<string, MutableTableReport>): Map<string, RawTable> {
  const tables = new Map<string, RawTable>();
  for (const canonicalName of SQLITE_HISTORY_TABLES) {
    const table = resolveTable(db, canonicalName);
    if (table === undefined) continue;
    const raw = readTable(db, table);
    const report = reports.get(canonicalName) ?? mutableReport();
    report.canonicalName = canonicalName;
    report.physicalName = table.physicalName;
    report.scanned += raw.values.length;
    report.rejected += raw.malformed;
    reports.set(canonicalName, report);
    tables.set(canonicalName, raw);
  }
  for (const table of excludedTableNames(db)) {
    if (tables.has(table.canonicalName)) continue;
    const result = normalizeSqliteResultRow(
      db.query(`SELECT count(*) AS count FROM ${quoteSqliteIdentifier(table.physicalName)}`).get(),
    );
    const count = typeof result?.count === "number" ? result.count : Number.NaN;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("SQLite history import rejected malformed table count");
    }
    const report = reports.get(table.canonicalName) ?? mutableReport();
    report.canonicalName = table.canonicalName;
    report.physicalName = table.physicalName;
    report.scanned += count;
    report.excluded += count;
    reports.set(table.canonicalName, report);
  }
  return tables;
}

function buildById(
  tables: ReadonlyMap<string, RawTable>,
): Map<string, ReadonlyMap<string, SourceRow>> {
  const result = new Map<string, ReadonlyMap<string, SourceRow>>();
  for (const [table, raw] of tables) {
    const indexed = new Map<string, SourceRow>();
    const validTable = (SQLITE_HISTORY_TABLES as readonly string[]).includes(table);
    if (!validTable) continue;
    for (const row of raw.rows) {
      const id = sourceId(table as HistoryTable, row);
      if (id !== undefined && !indexed.has(id)) indexed.set(id, row);
    }
    result.set(table, indexed);
  }
  return result;
}

function addWorkspaceCandidate(
  candidates: Set<string>,
  table: string,
  id: string | undefined,
  workspaceByTable: ReadonlyMap<string, ReadonlyMap<string, string>>,
  missing: { value: boolean },
): void {
  if (id === undefined) return;
  const index = workspaceByTable.get(table);
  if (!index) return;
  const workspace = index.get(id);
  if (workspace === undefined) missing.value = true;
  else candidates.add(workspace);
}

function directWorkspace(
  table: HistoryTable,
  row: SourceRow,
): { workspaceId: string | undefined; explicitNull: boolean; invalid: boolean } {
  if (!hasOwn(row, "workspace_id"))
    return { workspaceId: undefined, explicitNull: false, invalid: false };
  if (row.workspace_id === null)
    return { workspaceId: undefined, explicitNull: true, invalid: false };
  const value = textValue(row.workspace_id);
  return value === undefined
    ? { workspaceId: undefined, explicitNull: false, invalid: true }
    : { workspaceId: value, explicitNull: false, invalid: false };
}

function workspaceIndexes(
  tables: ReadonlyMap<string, RawTable>,
  byId: ReadonlyMap<string, ReadonlyMap<string, SourceRow>>,
): RowIndexes {
  const direct = new Map<string, Map<string, string>>();
  const duplicateIdsByTable = new Map<string, Set<string>>();
  const actorWorkspaceIds = new Map<string, Set<string>>();
  for (const [table, raw] of tables) {
    const tableIndex = new Map<string, string>();
    const seenIds = new Set<string>();
    const duplicateIds = new Set<string>();
    for (const row of raw.rows) {
      const id = sourceId(table as HistoryTable, row);
      if (id === undefined) continue;
      if (seenIds.has(id)) duplicateIds.add(id);
      else seenIds.add(id);
      const explicit = directWorkspace(table as HistoryTable, row);
      if (explicit.workspaceId !== undefined) tableIndex.set(id, explicit.workspaceId);
    }
    direct.set(table, tableIndex);
    if (duplicateIds.size > 0) duplicateIdsByTable.set(table, duplicateIds);
  }
  // Los Actors son identidades globales. Las membresías indican en qué
  // Workspaces seleccionados se puede recibir el evento de identidad.
  const memberships = tables.get("workspace_memberships")?.rows ?? [];
  for (const row of memberships) {
    const actorId = textValue(row.actor_id);
    const workspaceId = textValue(row.workspace_id);
    if (actorId !== undefined && workspaceId !== undefined) {
      const values = actorWorkspaceIds.get(actorId) ?? new Set<string>();
      values.add(workspaceId);
      actorWorkspaceIds.set(actorId, values);
    }
  }
  // Deriva alcances hasta alcanzar un punto fijo. Cada fila se agrega como
  // máximo una vez, por lo que el ciclo termina y no pierde scope por la
  // profundidad ni por el orden de inserción del snapshot SQLite.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [table, raw] of tables) {
      const refs = REFERENCED_WORKSPACE_FIELDS[table as HistoryTable] ?? [];
      const target = direct.get(table) ?? new Map<string, string>();
      for (const row of raw.rows) {
        const id = sourceId(table as HistoryTable, row);
        if (id === undefined || target.has(id)) continue;
        const candidates = new Set<string>();
        for (const [field, targetTable] of refs) {
          const reference = textValue(row[field]);
          addWorkspaceCandidate(candidates, targetTable, reference, direct, { value: false });
        }
        if (candidates.size === 1) {
          target.set(id, [...candidates][0]!);
          changed = true;
        }
      }
      direct.set(table, target);
    }
  }
  // Conserva la forma de tipos y mantiene los mapas inmutables para los callers.
  return { byTable: byId, workspaceByTable: direct, actorWorkspaceIds, duplicateIdsByTable };
}

function referencedWorkspaceIds(
  identity: RowIdentity,
  indexes: RowIndexes,
): {
  candidates: Set<string>;
  missing: boolean;
  invalid: boolean;
  explicitNull: boolean;
  unknownReferenceScope: boolean;
  ambiguous: boolean;
} {
  const { row, table } = identity;
  const candidates = new Set<string>();
  let missing = false;
  let invalid = false;
  let unknownReferenceScope = false;
  let ambiguous = indexes.duplicateIdsByTable.get(table)?.has(identity.sourceId) ?? false;
  const direct = directWorkspace(table, row);
  if (direct.invalid) invalid = true;
  if (direct.workspaceId !== undefined) {
    const workspaces = indexes.byTable.get("workspace");
    if (!workspaces || !workspaces.has(direct.workspaceId)) missing = true;
    else candidates.add(direct.workspaceId);
  }
  const refs = REFERENCED_WORKSPACE_FIELDS[table] ?? [];
  const required = REQUIRED_REFERENCE_FIELDS[table] ?? new Set<string>();
  for (const [field, targetTable] of refs) {
    if (!hasOwn(row, field)) {
      if (required.has(field)) missing = true;
      continue;
    }
    if (row[field] === null) {
      if (required.has(field)) missing = true;
      continue;
    }
    const value = textValue(row[field]);
    if (value === undefined) {
      invalid = true;
      continue;
    }
    if (targetTable === "actors") {
      if (indexes.duplicateIdsByTable.get("actors")?.has(value)) {
        ambiguous = true;
        continue;
      }
      const actor = indexes.byTable.get("actors")?.get(value);
      if (!actor) {
        missing = true;
        continue;
      }
      const actorWorkspaces = indexes.actorWorkspaceIds.get(value);
      if (direct.workspaceId !== undefined) {
        if (actorWorkspaces && !actorWorkspaces.has(direct.workspaceId)) missing = true;
      } else {
        for (const workspace of actorWorkspaces ?? []) candidates.add(workspace);
      }
      continue;
    }
    if (indexes.duplicateIdsByTable.get(targetTable)?.has(value)) {
      ambiguous = true;
      continue;
    }
    const targetRows = indexes.byTable.get(targetTable);
    if (!targetRows || !targetRows.has(value)) {
      missing = true;
      continue;
    }
    // Una fila destino sin workspace_id es válida en el esquema singleton legacy.
    // Un NULL explícito en el esquema multi-Workspace sigue siendo desconocido,
    // aunque una fila padre pudiera sugerir un alcance.
    const targetRow = targetRows.get(value)!;
    const targetScope = directWorkspace(targetTable, targetRow);
    if (targetScope.invalid) {
      missing = true;
      continue;
    }
    if (targetScope.explicitNull) {
      unknownReferenceScope = true;
      continue;
    }
    const workspace = indexes.workspaceByTable.get(targetTable)?.get(value);
    if (workspace === undefined) {
      unknownReferenceScope = true;
      continue;
    }
    const workspaces = indexes.byTable.get("workspace");
    if (!workspaces || !workspaces.has(workspace)) missing = true;
    else candidates.add(workspace);
  }
  if (table === "issue_subscribers") {
    // El contrato actual de suscriptores también exige una membresía de Workspace.
    // No aceptes la fila en silencio si falta la tabla o la fila referenciada.
    const memberships = indexes.byTable.get("workspace_memberships");
    const actorId = textValue(row.actor_id);
    const actorWorkspaces = actorId ? indexes.actorWorkspaceIds.get(actorId) : undefined;
    if (!memberships || !actorWorkspaces || actorWorkspaces.size === 0) {
      missing = true;
    } else if (direct.workspaceId !== undefined) {
      if (!actorWorkspaces.has(direct.workspaceId)) missing = true;
    } else {
      for (const workspace of actorWorkspaces) candidates.add(workspace);
    }
  }
  if (table === "actors") {
    const id = identity.sourceId;
    for (const workspace of indexes.actorWorkspaceIds.get(id) ?? []) candidates.add(workspace);
  }
  if (table === "workspace") {
    const id = textValue(row.id);
    if (id !== undefined) candidates.add(id);
    else invalid = true;
  }
  return {
    candidates,
    missing,
    invalid,
    explicitNull: direct.explicitNull,
    unknownReferenceScope,
    ambiguous,
  };
}

function rowScope(identity: RowIdentity, scope: SourceScope, indexes: RowIndexes): RowScope {
  const info = referencedWorkspaceIds(identity, indexes);
  if (info.invalid)
    return {
      workspaceId: undefined,
      outOfScope: false,
      orphaned: false,
      ambiguous: false,
      rejected: true,
    };
  if (info.ambiguous)
    return {
      workspaceId: undefined,
      outOfScope: false,
      orphaned: false,
      ambiguous: true,
      rejected: false,
    };
  const candidates = info.candidates;
  // La identidad del Actor es global. Se puede usar en más de un Workspace,
  // pero la importación seleccionada emite un único evento con alcance.
  const isGlobalActor = identity.table === "actors";
  if (isGlobalActor && scope.workspaceId !== undefined) {
    if (info.missing || (scope.multipleWorkspaces && info.unknownReferenceScope)) {
      return {
        workspaceId: undefined,
        outOfScope: false,
        orphaned: true,
        ambiguous: false,
        rejected: false,
      };
    }
    const memberships = indexes.actorWorkspaceIds.get(identity.sourceId);
    if (memberships && memberships.size > 0 && !memberships.has(scope.workspaceId)) {
      return {
        workspaceId: undefined,
        outOfScope: true,
        orphaned: false,
        ambiguous: false,
        rejected: false,
      };
    }
    if (memberships && memberships.size > 0) {
      return {
        workspaceId: scope.workspaceId,
        outOfScope: false,
        orphaned: false,
        ambiguous: false,
        rejected: false,
      };
    }
  }
  // Un alcance NULL en una fuente multi-Workspace no se vuelve seguro por un
  // join con el padre. La fuente no demuestra qué Workspace posee la fila.
  if (scope.multipleWorkspaces && info.explicitNull) {
    return {
      workspaceId: undefined,
      outOfScope: false,
      orphaned: true,
      ambiguous: false,
      rejected: false,
    };
  }
  if (candidates.size > 1) {
    return {
      workspaceId: undefined,
      outOfScope: false,
      orphaned: false,
      ambiguous: true,
      rejected: false,
    };
  }
  if (scope.multipleWorkspaces && info.unknownReferenceScope) {
    return {
      workspaceId: undefined,
      outOfScope: false,
      orphaned: true,
      ambiguous: false,
      rejected: false,
    };
  }
  const candidate = [...candidates][0];
  if (candidate !== undefined) {
    // Un destino FK ausente es un huérfano aunque otra referencia apunte a
    // otro Workspace. No ocultes el hallazgo de fila ausente como alcance.
    if (info.missing) {
      return {
        workspaceId: undefined,
        outOfScope: false,
        orphaned: true,
        ambiguous: false,
        rejected: false,
      };
    }
    if (scope.workspaceId !== undefined && candidate !== scope.workspaceId) {
      return {
        workspaceId: undefined,
        outOfScope: true,
        orphaned: false,
        ambiguous: false,
        rejected: false,
      };
    }
    return {
      workspaceId: scope.hasWorkspaceTable ? candidate : undefined,
      outOfScope: false,
      orphaned: info.missing,
      ambiguous: false,
      rejected: false,
    };
  }
  if (info.missing || (scope.multipleWorkspaces && info.explicitNull)) {
    return {
      workspaceId: undefined,
      outOfScope: false,
      orphaned: true,
      ambiguous: false,
      rejected: false,
    };
  }
  if (scope.multipleWorkspaces) {
    return {
      workspaceId: undefined,
      outOfScope: false,
      orphaned: true,
      ambiguous: false,
      rejected: false,
    };
  }
  return {
    workspaceId: scope.hasWorkspaceTable ? scope.workspaceId : undefined,
    outOfScope: false,
    orphaned: false,
    ambiguous: false,
    rejected: false,
  };
}

function issueIdentifier(indexes: RowIndexes, issueId: string): string | undefined {
  const issue = indexes.byTable.get("issues")?.get(issueId);
  if (!issue) return undefined;
  const teamId = textValue(issue.team_id);
  const number = textValue(issue.number);
  if (teamId === undefined || number === undefined) return undefined;
  const team = indexes.byTable.get("teams")?.get(teamId);
  const key = team ? textValue(team.key) : undefined;
  return key && number ? `${key}-${number}` : undefined;
}

function actorIdFor(
  table: HistoryTable,
  row: SourceRow,
  sourceIdValue: string,
): string | JsonObject {
  for (const field of [
    "actor_id",
    "author_id",
    "creator_id",
    "owner_id",
    "requester_id",
    "reviewer_id",
  ]) {
    const value = textValue(row[field]);
    if (value !== undefined) return value;
  }
  if (table === "actors") return sourceIdValue;
  // Los snapshots son registros explícitos de importación, no acciones de
  // dominio. Este Actor técnico registra la ausencia de autor sin inventar
  // un autor humano ni copiar una credencial.
  return { source: "sqlite", table };
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (!isRecord(value)) throw new Error("non-JSON value");
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item);
  return result;
}

function snapshotPayload(
  table: HistoryTable,
  row: SourceRow,
  sourceIdValue: string,
  indexes: RowIndexes,
): JsonObject {
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) payload[key] = jsonValue(value);
  // Mantiene como autoridad los metadatos de conversión aunque una columna
  // futura de la fuente use uno de estos nombres.
  payload.source = "sqlite";
  payload.sourceTable = table;
  payload.sourceId = sourceIdValue;
  if (table === "issues") {
    const identifier = issueIdentifier(indexes, sourceIdValue);
    if (identifier !== undefined) payload.identifier = identifier;
  }
  return payload;
}

function occurredAtFor(identity: RowIdentity, indexes: RowIndexes): string | undefined {
  for (const field of ["updated_at", "created_at", "occurred_at", "starts_at", "ends_at"]) {
    const value = textValue(identity.row[field]);
    if (value !== undefined && Number.isFinite(Date.parse(value)) && /T/iu.test(value))
      return value;
  }
  const refs = REFERENCED_WORKSPACE_FIELDS[identity.table] ?? [];
  for (const [field, targetTable] of refs) {
    const reference = textValue(identity.row[field]);
    if (reference === undefined) continue;
    const target = indexes.byTable.get(targetTable)?.get(reference);
    if (!target) continue;
    for (const targetField of ["updated_at", "created_at"]) {
      const value = textValue(target[targetField]);
      if (value !== undefined && Number.isFinite(Date.parse(value)) && /T/iu.test(value))
        return value;
    }
  }
  return undefined;
}

function snapshotEvent(
  identity: RowIdentity,
  workspaceId: string | undefined,
  indexes: RowIndexes,
): DomainEvent {
  const occurredAt = occurredAtFor(identity, indexes);
  if (occurredAt === undefined) throw new Error("missing timestamp");
  const input: Record<string, unknown> = {
    schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    eventId: `sqlite:${identity.table}:${identity.sourceId}`,
    aggregate: AGGREGATE_NAMES[identity.table],
    aggregateKey: identity.sourceId,
    type: "snapshot_imported",
    actor: actorIdFor(identity.table, identity.row, identity.sourceId),
    occurredAt,
    payload: snapshotPayload(identity.table, identity.row, identity.sourceId, indexes),
  };
  if (workspaceId !== undefined) input.workspaceId = workspaceId;
  // Valida con el mismo límite que EventLogWriter. Esto rechaza campos
  // prohibidos antes de cualquier append y no toca el destino.
  return validateDomainEvent(input);
}

function activityEvent(
  identity: RowIdentity,
  workspaceId: string | undefined,
  indexes: RowIndexes,
): DomainEvent | undefined {
  const issueId = textValue(identity.row.issue_id);
  const actorId = textValue(identity.row.actor_id);
  const actorName = textValue(identity.row.actor);
  const type = textValue(identity.row.type);
  const payload = textValue(identity.row.payload);
  const occurredAt = textValue(identity.row.created_at);
  const issue = issueId ? issueIdentifier(indexes, issueId) : undefined;
  if (
    !issueId ||
    !issue ||
    (!actorId && !actorName) ||
    !type ||
    payload === undefined ||
    !occurredAt
  ) {
    return undefined;
  }
  const row: ActivityEventRow = {
    id: identity.sourceId,
    issue_identifier: issue,
    issue_id: issueId,
    actor_id: actorId,
    actor: actorName ?? actorId ?? "unknown",
    type,
    payload,
    workspace_id: workspaceId,
    occurred_at: occurredAt,
  };
  return activityToDomainEvent(row);
}

function compareEvents(left: DomainEvent, right: DomainEvent): number {
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  return (
    leftTime - rightTime ||
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function addCandidate(
  event: DomainEvent,
  table: string,
  reports: Map<string, MutableTableReport>,
  warnings: string[],
  existing: ReadonlyMap<string, DomainEvent>,
  pending: Map<string, DomainEvent>,
  equivalent: (left: DomainEvent, right: DomainEvent) => boolean = areDomainEventsEquivalent,
): void {
  const report = reports.get(table) ?? mutableReport();
  reports.set(table, report);
  const previous = pending.get(event.eventId) ?? existing.get(event.eventId);
  if (previous !== undefined) {
    if (equivalent(previous, event)) {
      addFinding(report, "duplicate");
    } else {
      addFinding(report, "ambiguous");
      warn(warnings, "ambiguous", table, event.eventId);
    }
    return;
  }
  pending.set(event.eventId, event);
}

/**
 * Importa el histórico compartido completo desde un snapshot SQLite consistente.
 *
 * Las filas de Activity conservan sus IDs y tipos de evento originales. Las filas
 * sin un evento histórico explícito se representan como registros `snapshot_imported`;
 * es una conversión explícita de la fuente, no una acción de usuario fabricada. Cada
 * snapshot contiene la fila completa de la fuente y referencias estables.
 */
export function importSqliteHistory(
  options: SQLiteHistoryImportOptions,
): SQLiteHistoryImportResult {
  const batchSize = validateBatchSize(options.batchSize);
  const scope = resolveScope(options.db, options.workspaceId);
  const reports = new Map<string, MutableTableReport>();
  const warnings: string[] = [];
  const tables = tableRows(options.db, reports);
  const byId = buildById(tables);
  const indexes = workspaceIndexes(tables, byId);
  const writer = new EventLogWriter({ rootDir: options.rootDir });
  // Solo una importación real puede reparar un tail truncado; el dry-run no
  // debe modificar el Log y falla cerrado si el stream no es legible.
  if (!options.dryRun) writer.recover();
  const existing = new Map(writer.read().map((event) => [event.eventId, event]));
  const pending = new Map<string, DomainEvent>();
  let orphaned = 0;
  let outOfScope = 0;
  let rejected = [...tables.values()].reduce((total, raw) => total + raw.malformed, 0);
  let ambiguous = 0;
  let duplicates = 0;
  const includeActivity = options.includeActivity !== false;
  const includeSnapshots = options.includeSnapshots !== false;

  for (const table of SQLITE_HISTORY_TABLES) {
    const raw = tables.get(table);
    if (!raw) continue;
    const report = reports.get(table) ?? mutableReport();
    reports.set(table, report);
    for (const row of raw.rows) {
      const id = sourceId(table, row);
      if (id === undefined) {
        rejected += 1;
        addFinding(report, "rejected");
        warn(warnings, "rejected", table);
        continue;
      }
      const identity: RowIdentity = { table, row, sourceId: id };
      const rowScopeResult = rowScope(identity, scope, indexes);
      if (rowScopeResult.rejected) {
        rejected += 1;
        addFinding(report, "rejected");
        warn(warnings, "rejected", table, id);
        continue;
      }
      if (rowScopeResult.outOfScope) {
        outOfScope += 1;
        addFinding(report, "outOfScope");
        warn(warnings, "out_of_scope", table, id);
        continue;
      }
      if (rowScopeResult.ambiguous) {
        ambiguous += 1;
        addFinding(report, "ambiguous");
        warn(warnings, "ambiguous", table, id);
        continue;
      }
      if (rowScopeResult.orphaned) {
        orphaned += 1;
        addFinding(report, "orphaned");
        warn(warnings, "orphaned", table, id);
        continue;
      }
      if (table === "activity") {
        if (!includeActivity) continue;
        const event = activityEvent(identity, rowScopeResult.workspaceId, indexes);
        if (event === undefined) {
          rejected += 1;
          addFinding(report, "rejected");
          warn(warnings, "rejected", table, id);
          continue;
        }
        const before = pending.size;
        addCandidate(
          event,
          table,
          reports,
          warnings,
          existing,
          pending,
          areActivityEventsEquivalent,
        );
        if (pending.size === before) {
          const previous = pending.get(event.eventId) ?? existing.get(event.eventId);
          if (previous && areActivityEventsEquivalent(previous, event)) duplicates += 1;
          else ambiguous += 1;
        }
        continue;
      }
      if (!includeSnapshots) continue;
      let event: DomainEvent;
      try {
        event = snapshotEvent(identity, rowScopeResult.workspaceId, indexes);
        // Valida ahora para informar las filas malformadas y evitar append
        // parciales posteriores. Es un límite en memoria sin efectos.
        validateDomainEvent(event);
      } catch {
        rejected += 1;
        addFinding(report, "rejected");
        warn(warnings, "rejected", table, id);
        continue;
      }
      const before = pending.size;
      addCandidate(event, table, reports, warnings, existing, pending);
      if (pending.size === before) {
        const previous = pending.get(event.eventId) ?? existing.get(event.eventId);
        if (previous && areDomainEventsEquivalent(previous, event)) duplicates += 1;
        else ambiguous += 1;
      }
    }
  }

  const events = [...pending.values()].sort(compareEvents);
  // Si el proceso termina después de un lote, la siguiente ejecución ve los
  // IDs exactos como duplicados y continúa. No requiere checkpoint ni offset.
  let written = 0;
  if (!options.dryRun && events.length > 0) {
    writer.recover();
    for (let offset = 0; offset < events.length; offset += batchSize) {
      const chunk = events.slice(offset, offset + batchSize);
      const results = writer.appendMany(chunk);
      written += results.filter((result) => result.appended).length;
    }
  }
  for (const event of events) {
    const table = event.eventId.startsWith("sqlite:")
      ? (event.eventId.split(":")[1] ?? event.aggregate)
      : "activity";
    const report = reports.get(table) ?? mutableReport();
    addFinding(report, "emitted");
    reports.set(table, report);
  }

  const excluded = [...reports.values()].reduce((sum, report) => sum + report.excluded, 0);
  const scanned = [...reports.values()].reduce((sum, report) => sum + report.scanned, 0);
  return {
    status: "completed",
    dryRun: options.dryRun === true,
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
    multipleWorkspaces: scope.multipleWorkspaces,
    scanned,
    emitted: events.length,
    converted: events.length,
    written,
    batches: events.length === 0 ? 0 : Math.ceil(events.length / batchSize),
    duplicates,
    orphaned,
    outOfScope,
    rejected,
    ambiguous,
    excluded,
    tables: immutableReports(reports),
    warnings,
  };
}

/** Alias para callers que nombran el destino en lugar de la fuente. */
export const importSqliteCanonicalEvents = importSqliteHistory;
export const importSqliteEventLog = importSqliteHistory;
