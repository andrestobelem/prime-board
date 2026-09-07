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
  /** IDs de Activity, aunque un JOIN acotado no encuentre el padre. */
  readonly source_issue_id: string | null;
  readonly source_actor_id: string | null;
  readonly type: string;
  readonly payload: string;
  readonly occurred_at: string;
}

interface ResolvedTable {
  readonly canonicalName: string;
  readonly physicalName: string;
}

type SourceRow = Record<string, unknown>;

interface SourceTable {
  readonly table: ResolvedTable | undefined;
  readonly rows: readonly SourceRow[];
  readonly rowsById: ReadonlyMap<string, readonly SourceRow[]>;
  readonly workspaceLookup: SQLiteColumnLookup;
  readonly malformed: number;
}

const SCOPED_REFERENCE_TABLES = [
  "activity",
  "actors",
  "teams",
  "issues",
  "workflow_states",
  "projects",
  "project_teams",
  "milestones",
  "cycles",
  "labels",
  "issue_labels",
  "issue_relations",
  "comments",
  "team_memberships",
  "initiatives",
  "initiative_projects",
  "initiative_teams",
  "project_updates",
  "reviews",
  "issue_subscribers",
  "saved_views",
] as const;

type ScopedReferenceTable = (typeof SCOPED_REFERENCE_TABLES)[number];

type WorkspaceObservation =
  | {
      readonly kind: "value";
      readonly table: ScopedReferenceTable;
      readonly workspaceId: string;
      readonly id: string | undefined;
    }
  | {
      readonly kind: "unknown";
      readonly table: ScopedReferenceTable;
      readonly id: string | undefined;
      readonly reason: "absent" | "null";
    }
  | {
      readonly kind: "invalid";
      readonly table: ScopedReferenceTable;
      readonly id: string | undefined;
    };

interface ActivityScopeEvidence {
  readonly observations: readonly WorkspaceObservation[];
  readonly missingReference: boolean;
  readonly ambiguousReference: boolean;
  readonly hasScopedObservation: boolean;
  readonly directActivityWorkspaceId: string | undefined;
  readonly rootIssueId: string | undefined;
  readonly actorWorkspaceRefs: readonly ReadonlySet<string>[];
}

type WorkspaceMembershipMetadataState = "found" | "missing" | "ambiguous" | "invalid";

interface WorkspaceMembershipMetadata {
  readonly state: WorkspaceMembershipMetadataState;
  /** Distingue una tabla ausente de metadata scoped incompleta. */
  readonly tablePresent: boolean;
  /** IDs de Workspace extraídos de filas de Membership completas. */
  readonly workspaceIds: ReadonlySet<string>;
}

interface ActorWorkspaceIndex {
  readonly workspaceMembershipMetadata: WorkspaceMembershipMetadata;
  readonly actorWorkspaceIds: ReadonlyMap<string, ReadonlySet<string>>;
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
  readonly hasWorkspaceTable: boolean;
  /** Workspace, Membership o columnas de alcance prueban que no es legacy puro. */
  readonly hasScopedMetadata: boolean;
  readonly scopedTables: ReadonlyMap<ScopedReferenceTable, SourceTable>;
  readonly workspaceMembershipMetadata: WorkspaceMembershipMetadata;
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
  const sourceIssueId = nullableTextValue(row.source_issue_id);
  const sourceActorId = nullableTextValue(row.source_actor_id);
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
    teamWorkspaceId === undefined ||
    sourceIssueId === undefined ||
    sourceActorId === undefined
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
    source_issue_id: sourceIssueId,
    source_actor_id: sourceActorId,
    type,
    payload,
    occurred_at: occurredAt,
  };
}

function readSourceTable(db: Database, table: ResolvedTable | undefined): SourceTable {
  if (table === undefined) {
    return {
      table: undefined,
      rows: [],
      rowsById: new Map(),
      workspaceLookup: { kind: "missing" },
      malformed: 0,
    };
  }
  const values = db
    .query(`SELECT * FROM ${quoteSqliteIdentifier(table.physicalName)}`)
    .all() as unknown[];
  const rows: SourceRow[] = [];
  let malformed = 0;
  for (const value of values) {
    const row = normalizeSqliteResultRow(value);
    if (row === undefined) malformed += 1;
    else rows.push(row);
  }
  const rowsById = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const id = textValue(row.id);
    if (id === undefined) continue;
    const matches = rowsById.get(id) ?? [];
    matches.push(row);
    rowsById.set(id, matches);
  }
  return {
    table,
    rows,
    rowsById,
    workspaceLookup: sqliteColumnName(db, table.physicalName, "workspace_id"),
    malformed,
  };
}

function readScopedTables(
  db: Database,
  tables: ReadonlyMap<ScopedReferenceTable, ResolvedTable | undefined>,
): ReadonlyMap<ScopedReferenceTable, SourceTable> {
  return new Map(
    SCOPED_REFERENCE_TABLES.map((name) => [name, readSourceTable(db, tables.get(name))]),
  );
}

function sourceRows(
  scope: ImportScope,
  table: ScopedReferenceTable,
  id: string,
): readonly SourceRow[] {
  return scope.scopedTables.get(table)?.rowsById.get(id) ?? [];
}

function sourceTable(scope: ImportScope, table: ScopedReferenceTable): SourceTable {
  return (
    scope.scopedTables.get(table) ?? {
      table: undefined,
      rows: [],
      rowsById: new Map(),
      workspaceLookup: { kind: "missing" },
      malformed: 0,
    }
  );
}

type DirectWorkspace =
  | { readonly kind: "absent" }
  | { readonly kind: "null" }
  | { readonly kind: "value"; readonly workspaceId: string }
  | { readonly kind: "invalid" };

function directWorkspace(row: SourceRow, source: SourceTable): DirectWorkspace {
  if (source.table === undefined || source.workspaceLookup.kind === "missing") {
    return { kind: "absent" };
  }
  if (source.workspaceLookup.kind === "ambiguous" || source.workspaceLookup.kind === "invalid") {
    return { kind: "invalid" };
  }
  const value = row[source.workspaceLookup.name.toLowerCase()];
  if (value === null || value === undefined) return { kind: "null" };
  const workspaceId = textValue(value);
  return workspaceId === undefined ? { kind: "invalid" } : { kind: "value", workspaceId };
}

function addWorkspaceObservation(
  observations: WorkspaceObservation[],
  table: ScopedReferenceTable,
  row: SourceRow,
  source: SourceTable,
): DirectWorkspace {
  const id = textValue(row.id);
  const direct = directWorkspace(row, source);
  if (direct.kind === "value")
    observations.push({ kind: "value", table, workspaceId: direct.workspaceId, id });
  else if (direct.kind === "null" || direct.kind === "absent")
    observations.push({ kind: "unknown", table, id, reason: direct.kind });
  else observations.push({ kind: "invalid", table, id });
  return direct;
}

function addReferencedRows(
  scope: ImportScope,
  observations: WorkspaceObservation[],
  queue: Array<{ readonly table: ScopedReferenceTable; readonly row: SourceRow }>,
  table: ScopedReferenceTable,
  id: string | undefined,
  required: boolean,
  missing: { value: boolean },
  ambiguous: { value: boolean },
): void {
  if (id === undefined) {
    if (required) {
      missing.value = true;
    }
    return;
  }
  const source = sourceTable(scope, table);
  if (source.table === undefined) {
    missing.value = true;
    return;
  }
  const rows = source.rowsById.get(id) ?? [];
  if (rows.length === 0) {
    missing.value = true;
    return;
  }
  if (rows.length > 1) {
    ambiguous.value = true;
    return;
  }
  const row = rows[0];
  if (row === undefined) {
    missing.value = true;
    return;
  }
  addWorkspaceObservation(observations, table, row, source);
  queue.push({ table, row });
}

function textReference(row: SourceRow, field: string): string | undefined {
  const value = row[field];
  return value === null || value === undefined ? undefined : textValue(value);
}

type RowReference = readonly [field: string, table: ScopedReferenceTable, required: boolean];

const ROW_REFERENCES: Partial<Record<ScopedReferenceTable, readonly RowReference[]>> = {
  teams: [["default_state_id", "workflow_states", false]],
  workflow_states: [["team_id", "teams", true]],
  projects: [],
  project_teams: [
    ["project_id", "projects", true],
    ["team_id", "teams", true],
  ],
  milestones: [["project_id", "projects", true]],
  cycles: [["team_id", "teams", true]],
  issues: [
    ["team_id", "teams", true],
    ["state_id", "workflow_states", false],
    ["parent_id", "issues", false],
    ["project_id", "projects", false],
    ["milestone_id", "milestones", false],
    ["cycle_id", "cycles", false],
  ],
  labels: [["team_id", "teams", false]],
  issue_labels: [
    ["issue_id", "issues", true],
    ["label_id", "labels", true],
  ],
  issue_relations: [
    ["issue_id", "issues", true],
    ["related_id", "issues", true],
  ],
  comments: [["issue_id", "issues", true]],
  team_memberships: [["team_id", "teams", true]],
  initiatives: [],
  initiative_projects: [
    ["initiative_id", "initiatives", true],
    ["project_id", "projects", true],
  ],
  initiative_teams: [
    ["initiative_id", "initiatives", true],
    ["team_id", "teams", true],
  ],
  project_updates: [["project_id", "projects", true]],
  reviews: [["issue_id", "issues", true]],
  issue_subscribers: [["issue_id", "issues", true]],
};

type ActorReference = readonly [field: string, required: boolean];

const ACTOR_REFERENCES: Partial<Record<ScopedReferenceTable, readonly ActorReference[]>> = {
  issues: [
    ["assignee_id", false],
    ["creator_id", true],
  ],
  projects: [["lead_id", false]],
  initiatives: [["owner_id", false]],
  comments: [["actor_id", true]],
  team_memberships: [["actor_id", true]],
  project_updates: [["author_id", true]],
  reviews: [
    ["requester_id", true],
    ["reviewer_id", true],
  ],
  issue_subscribers: [["actor_id", true]],
  saved_views: [["owner_id", true]],
};

interface RelationLink {
  readonly relationTable:
    | "project_teams"
    | "issue_relations"
    | "issue_labels"
    | "team_memberships"
    | "initiative_projects"
    | "initiative_teams"
    | "project_updates"
    | "reviews"
    | "issue_subscribers"
    | "comments";
  readonly sourceTable: ScopedReferenceTable;
  readonly field: string;
}

const RELATION_LINKS: readonly RelationLink[] = [
  { relationTable: "project_teams", sourceTable: "projects", field: "project_id" },
  { relationTable: "project_teams", sourceTable: "teams", field: "team_id" },
  { relationTable: "initiative_projects", sourceTable: "projects", field: "project_id" },
  { relationTable: "initiative_projects", sourceTable: "initiatives", field: "initiative_id" },
  { relationTable: "initiative_teams", sourceTable: "teams", field: "team_id" },
  { relationTable: "initiative_teams", sourceTable: "initiatives", field: "initiative_id" },
  { relationTable: "project_updates", sourceTable: "projects", field: "project_id" },
  { relationTable: "issue_relations", sourceTable: "issues", field: "issue_id" },
  { relationTable: "issue_relations", sourceTable: "issues", field: "related_id" },
  { relationTable: "issue_labels", sourceTable: "issues", field: "issue_id" },
  { relationTable: "comments", sourceTable: "issues", field: "issue_id" },
  { relationTable: "reviews", sourceTable: "issues", field: "issue_id" },
  { relationTable: "issue_subscribers", sourceTable: "issues", field: "issue_id" },
  { relationTable: "team_memberships", sourceTable: "teams", field: "team_id" },
];

function referencedId(
  row: SourceRow,
  field: string,
  required: boolean,
  missing: { value: boolean },
  ambiguous: { value: boolean },
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    if (required) missing.value = true;
    return undefined;
  }
  const value = row[field];
  if (value === null || value === undefined) {
    if (required) missing.value = true;
    return undefined;
  }
  const id = textValue(value);
  if (id === undefined) ambiguous.value = true;
  return id;
}

function addActorReference(
  scope: ImportScope,
  observations: WorkspaceObservation[],
  id: string | undefined,
  missing: { value: boolean },
  ambiguous: { value: boolean },
  actorWorkspaceRefs: Array<ReadonlySet<string>>,
): void {
  if (id === undefined) {
    missing.value = true;
    return;
  }
  const source = sourceTable(scope, "actors");
  if (source.table === undefined) {
    missing.value = true;
    return;
  }
  const rows = source.rowsById.get(id) ?? [];
  if (rows.length === 0) {
    missing.value = true;
    return;
  }
  if (rows.length > 1) {
    ambiguous.value = true;
    return;
  }
  const actor = rows[0];
  if (actor === undefined) {
    missing.value = true;
    return;
  }
  // Actor es una identidad global. Su columna legacy de Workspace no es una
  // prueba de pertenencia, porque un Actor puede pertenecer a varios Workspaces.
  // La Membership sigue siendo la autoridad y se valida aparte.
  const membershipState = scope.workspaceMembershipMetadata.state;
  if (membershipState === "ambiguous" || membershipState === "invalid") {
    ambiguous.value = true;
    return;
  }
  if (membershipState === "missing") {
    const missingMembershipMetadata =
      scope.multipleWorkspaces ||
      scope.workspaceMembershipMetadata.tablePresent ||
      (!scope.hasWorkspaceTable && scope.hasScopedMetadata);
    if (missingMembershipMetadata) ambiguous.value = true;
    return;
  }
  const workspaces = scope.actorWorkspaceIds.get(id);
  if (workspaces === undefined || workspaces.size === 0) {
    missing.value = true;
    return;
  }
  actorWorkspaceRefs.push(workspaces);
}

function addActorFieldReference(
  scope: ImportScope,
  observations: WorkspaceObservation[],
  row: SourceRow,
  field: string,
  required: boolean,
  missing: { value: boolean },
  ambiguous: { value: boolean },
  actorWorkspaceRefs: Array<ReadonlySet<string>>,
): void {
  // Las columnas históricas pueden no existir. Una columna existente con NULL,
  // en cambio, no prueba la relación cuando el contrato la exige.
  if (!Object.prototype.hasOwnProperty.call(row, field)) return;
  const id = referencedId(row, field, required, missing, ambiguous);
  if (id !== undefined) {
    addActorReference(scope, observations, id, missing, ambiguous, actorWorkspaceRefs);
  }
}

function collectActivityScopeEvidence(scope: ImportScope, row: ActivityRow): ActivityScopeEvidence {
  const observations: WorkspaceObservation[] = [];
  const missing = { value: false };
  const ambiguous = { value: false };
  const actorWorkspaceRefs: Array<ReadonlySet<string>> = [];
  const visited = new Set<SourceRow>();
  const queue: Array<{ readonly table: ScopedReferenceTable; readonly row: SourceRow }> = [];
  let directActivityWorkspaceId: string | undefined;
  const activityMatches = sourceRows(scope, "activity", row.id);
  if (activityMatches.length > 1) {
    ambiguous.value = true;
  } else if (activityMatches.length === 1) {
    const activity = activityMatches[0];
    if (activity === undefined) {
      ambiguous.value = true;
    } else {
      const direct = addWorkspaceObservation(
        observations,
        "activity",
        activity,
        sourceTable(scope, "activity"),
      );
      if (direct.kind === "value") directActivityWorkspaceId = direct.workspaceId;
      const issueId = referencedId(activity, "issue_id", true, missing, ambiguous);
      if (issueId !== undefined) {
        addReferencedRows(scope, observations, queue, "issues", issueId, true, missing, ambiguous);
      }
    }
  } else if (scope.activityHasWorkspace) {
    const syntheticActivity: SourceRow = {
      id: row.id,
      workspace_id: row.activity_workspace_id,
    };
    const direct = addWorkspaceObservation(
      observations,
      "activity",
      syntheticActivity,
      sourceTable(scope, "activity"),
    );
    if (direct.kind === "value") directActivityWorkspaceId = direct.workspaceId;
    if (row.source_issue_id === null) missing.value = true;
    else {
      addReferencedRows(
        scope,
        observations,
        queue,
        "issues",
        row.source_issue_id,
        true,
        missing,
        ambiguous,
      );
    }
  } else if (row.source_issue_id === null) {
    missing.value = true;
  } else {
    addReferencedRows(
      scope,
      observations,
      queue,
      "issues",
      row.source_issue_id,
      true,
      missing,
      ambiguous,
    );
  }

  if (row.source_actor_id === null) {
    missing.value = true;
  } else {
    addActorReference(
      scope,
      observations,
      row.source_actor_id,
      missing,
      ambiguous,
      actorWorkspaceRefs,
    );
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined || visited.has(item.row)) continue;
    visited.add(item.row);
    const { table, row: sourceRow } = item;
    for (const [field, targetTable, required] of ROW_REFERENCES[table] ?? []) {
      const reference = referencedId(sourceRow, field, required, missing, ambiguous);
      if (reference !== undefined) {
        addReferencedRows(
          scope,
          observations,
          queue,
          targetTable,
          reference,
          required,
          missing,
          ambiguous,
        );
      }
    }
    for (const [field, required] of ACTOR_REFERENCES[table] ?? []) {
      addActorFieldReference(
        scope,
        observations,
        sourceRow,
        field,
        required,
        missing,
        ambiguous,
        actorWorkspaceRefs,
      );
    }
    const id = textValue(sourceRow.id);
    if (id === undefined) continue;
    for (const link of RELATION_LINKS) {
      if (link.sourceTable !== table) continue;
      const relationSource = sourceTable(scope, link.relationTable);
      for (const relation of relationSource.rows) {
        if (textReference(relation, link.field) !== id) continue;
        addWorkspaceObservation(observations, link.relationTable, relation, relationSource);
        queue.push({ table: link.relationTable, row: relation });
      }
    }
  }

  return {
    observations,
    missingReference: missing.value,
    ambiguousReference: ambiguous.value,
    hasScopedObservation:
      observations.some(
        (observation) =>
          scope.scopedTables.get(observation.table)?.workspaceLookup.kind === "found",
      ) ||
      observations.some(
        (observation) =>
          observation.kind === "unknown" &&
          observation.table === "issues" &&
          observation.id !== (row.source_issue_id ?? undefined),
      ) ||
      (scope.workspaceMembershipMetadata.tablePresent &&
        observations.some(
          (observation) =>
            observation.kind === "unknown" &&
            observation.table !== "activity" &&
            observation.table !== "issues" &&
            observation.table !== "teams",
        )),
    directActivityWorkspaceId,
    rootIssueId: row.source_issue_id ?? undefined,
    actorWorkspaceRefs,
  };
}

type ActivityScopeDecision =
  | { readonly kind: "valid"; readonly workspaceId: string | undefined }
  | { readonly kind: "orphaned" }
  | { readonly kind: "outOfScope" }
  | { readonly kind: "ambiguous" };

function activityScopeDecision(row: ActivityRow, scope: ImportScope): ActivityScopeDecision {
  const evidence = collectActivityScopeEvidence(scope, row);
  if (evidence.ambiguousReference) return { kind: "ambiguous" };
  if (evidence.missingReference) {
    return { kind: "orphaned" };
  }
  if (evidence.observations.some((observation) => observation.kind === "invalid")) {
    return { kind: "ambiguous" };
  }

  const workspaceIds = new Set(
    evidence.observations
      .filter(
        (observation): observation is Extract<WorkspaceObservation, { kind: "value" }> =>
          observation.kind === "value",
      )
      .map((observation) => observation.workspaceId),
  );
  for (const workspaceId of workspaceIds) {
    if (!scope.workspaceIds.has(workspaceId)) return { kind: "orphaned" };
  }
  if (workspaceIds.size > 1) return { kind: "orphaned" };

  const unknown = evidence.observations.filter(
    (observation): observation is Extract<WorkspaceObservation, { kind: "unknown" }> =>
      observation.kind === "unknown",
  );
  const unknownIssueReferences = unknown.filter((observation) => observation.table === "issues");
  const hasUnknownRootIssue = unknownIssueReferences.some(
    (observation) => observation.id === evidence.rootIssueId,
  );
  const hasUnknownNonRootIssue = unknownIssueReferences.some(
    (observation) => observation.id !== evidence.rootIssueId,
  );
  const hasUnknownParent = unknown.some((observation) => observation.table !== "issues");
  const hasUnprovenScope =
    hasUnknownParent ||
    hasUnknownNonRootIssue ||
    (unknownIssueReferences.length > 0 && !hasUnknownRootIssue);
  if (scope.multipleWorkspaces && unknown.some((observation) => observation.reason === "null")) {
    return { kind: "orphaned" };
  }

  const candidate = [...workspaceIds][0];
  if (candidate !== undefined) {
    if (scope.workspaceId !== undefined && candidate !== scope.workspaceId) {
      // Un scope seleccionado de Activity con un padre distinto indica una
      // relación corrupta, no una fila normal fuera de alcance.
      if (evidence.directActivityWorkspaceId === scope.workspaceId) {
        return { kind: "orphaned" };
      }
      return { kind: "outOfScope" };
    }
    for (const actorWorkspaces of evidence.actorWorkspaceRefs) {
      if (!actorWorkspaces.has(candidate)) return { kind: "orphaned" };
    }
    if (hasUnprovenScope && !(scope.hasWorkspaceTable && !scope.multipleWorkspaces)) {
      return { kind: scope.multipleWorkspaces ? "orphaned" : "ambiguous" };
    }
    return { kind: "valid", workspaceId: candidate };
  }

  if (scope.workspaceId !== undefined) {
    for (const actorWorkspaces of evidence.actorWorkspaceRefs) {
      if (!actorWorkspaces.has(scope.workspaceId)) return { kind: "outOfScope" };
    }
  }
  if (!evidence.hasScopedObservation) {
    // Una Membership única puede conservar la inferencia legacy. Varias
    // Memberships no demuestran cuál era el Workspace del evento si no existe
    // una observación directa en Activity o en sus padres.
    if (evidence.actorWorkspaceRefs.some((workspaces) => workspaces.size > 1)) {
      return { kind: "ambiguous" };
    }
    return {
      kind: "valid",
      workspaceId: scope.hasWorkspaceTable ? scope.workspaceId : undefined,
    };
  }
  if (scope.hasWorkspaceTable && !scope.multipleWorkspaces) {
    return { kind: "valid", workspaceId: scope.workspaceId };
  }
  return { kind: scope.multipleWorkspaces ? "orphaned" : "ambiguous" };
}

function actorWorkspaceIndexes(
  db: Database,
  membershipsTable: ResolvedTable | undefined,
): ActorWorkspaceIndex {
  if (membershipsTable === undefined) {
    return {
      workspaceMembershipMetadata: {
        state: "missing",
        tablePresent: false,
        workspaceIds: new Set(),
      },
      actorWorkspaceIds: new Map(),
    };
  }
  const empty = (state: WorkspaceMembershipMetadataState): ActorWorkspaceIndex => ({
    workspaceMembershipMetadata: {
      state,
      tablePresent: true,
      workspaceIds: new Set(),
    },
    actorWorkspaceIds: new Map(),
  });
  const actorLookup = sqliteColumnName(db, membershipsTable.physicalName, "actor_id");
  const workspaceLookup = sqliteColumnName(db, membershipsTable.physicalName, "workspace_id");
  if (actorLookup.kind === "invalid" || workspaceLookup.kind === "invalid") {
    return empty("invalid");
  }
  if (actorLookup.kind === "ambiguous" || workspaceLookup.kind === "ambiguous") {
    return empty("ambiguous");
  }
  if (actorLookup.kind === "missing" || workspaceLookup.kind === "missing") {
    return empty("missing");
  }
  const rawRows = db
    .query(`SELECT * FROM ${quoteSqliteIdentifier(membershipsTable.physicalName)}`)
    .all() as unknown[];
  if (rawRows.some((value) => normalizeSqliteResultRow(value) === undefined)) {
    return empty("invalid");
  }
  const rows = db
    .query(
      `SELECT ${quoteSqliteIdentifier(actorLookup.name)} AS actor_id, ${quoteSqliteIdentifier(workspaceLookup.name)} AS workspace_id FROM ${quoteSqliteIdentifier(membershipsTable.physicalName)}`,
    )
    .all() as unknown[];
  const result = new Map<string, Set<string>>();
  const workspaceIds = new Set<string>();
  for (const value of rows) {
    const row = normalizeSqliteResultRow(value);
    if (row === undefined) return empty("invalid");
    const actorId = textValue(row.actor_id);
    const workspaceId = textValue(row.workspace_id);
    // Una fila NULL o vacía no prueba ninguna pertenencia. No construyas un
    // mapa parcial ni recurras al singleton legacy cuando existe la tabla.
    if (actorId === undefined || workspaceId === undefined) return empty("invalid");
    const workspaces = result.get(actorId) ?? new Set<string>();
    workspaces.add(workspaceId);
    result.set(actorId, workspaces);
    workspaceIds.add(workspaceId);
  }
  return {
    workspaceMembershipMetadata: {
      state: "found",
      tablePresent: true,
      workspaceIds,
    },
    actorWorkspaceIds: result,
  };
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
  const resolvedScopedTables = new Map<ScopedReferenceTable, ResolvedTable | undefined>(
    SCOPED_REFERENCE_TABLES.map((name) => {
      if (name === "activity") return [name, activityTable];
      if (name === "issues") return [name, issueTable];
      if (name === "teams") return [name, teamTable];
      if (name === "actors") return [name, actorTable];
      return [name, resolveTable(db, name)];
    }),
  );
  const scopedTables = readScopedTables(db, resolvedScopedTables);
  const actorWorkspaceIndex = actorWorkspaceIndexes(db, membershipsTable);
  let membershipMetadata = actorWorkspaceIndex.workspaceMembershipMetadata;
  const hasScopedMetadata =
    workspaceTable !== undefined ||
    membershipMetadata.tablePresent ||
    [...scopedTables.values()].some((source) => source.workspaceLookup.kind !== "missing");
  if (
    requestedWorkspaceId !== undefined &&
    workspaceTable === undefined &&
    !membershipMetadata.tablePresent &&
    hasScopedMetadata
  ) {
    throw new Error(
      "SQLite event import workspaceId requires a workspace table or valid workspace membership metadata",
    );
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
  } else if (membershipMetadata.state === "found") {
    // Una fuente sin tabla Workspace puede demostrar su topología con las
    // referencias completas de sus Memberships.
    workspaceIds.push(...membershipMetadata.workspaceIds);
  }
  if (workspaceTable !== undefined && workspaceIds.length === 0) {
    throw new Error("SQLite event import requires at least one Workspace");
  }
  if (
    workspaceTable !== undefined &&
    membershipMetadata.state === "found" &&
    [...membershipMetadata.workspaceIds].some((id) => !workspaceIds.includes(id))
  ) {
    membershipMetadata = {
      ...membershipMetadata,
      state: "invalid",
    };
  }
  const multipleWorkspaces = workspaceIds.length > 1;
  if (multipleWorkspaces && requestedWorkspaceId === undefined) {
    throw new Error(
      "SQLite event import requires workspaceId when the source contains multiple Workspaces",
    );
  }
  if (
    requestedWorkspaceId !== undefined &&
    (workspaceTable !== undefined || membershipMetadata.state === "found") &&
    !workspaceIds.includes(requestedWorkspaceId)
  ) {
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
  const scopedEntityTables = SCOPED_REFERENCE_TABLES.map(
    (table) => [table, scopedTables.get(table)?.table] as const,
  );
  const ambiguousTables: string[] = scopedEntityTables
    .filter(([, table]) => hasAmbiguousTableMetadata(db, table))
    .map(([table]) => table);
  for (const [table, lookup] of workspaceColumnLookups) {
    if (isAmbiguousColumn(lookup) && !ambiguousTables.includes(table)) {
      ambiguousTables.push(table);
    }
  }
  for (const table of SCOPED_REFERENCE_TABLES) {
    const lookup = scopedTables.get(table)?.workspaceLookup;
    if (lookup !== undefined && isAmbiguousColumn(lookup) && !ambiguousTables.includes(table)) {
      ambiguousTables.push(table);
    }
  }
  if (multipleWorkspaces && ambiguousTables.length > 0) {
    throw new Error(
      `SQLite event import rejected ambiguous column metadata on ${ambiguousTables.join(", ")}`,
    );
  }
  // Una topología inferida desde Memberships puede clasificar las filas por
  // Actor aunque las tablas legacy aún no tengan workspace_id. La exigencia de
  // columnas directas se conserva para una tabla Workspace multi-Workspace.
  if (
    workspaceTable !== undefined &&
    multipleWorkspaces &&
    workspaceColumnLookups.some(([, lookup]) => lookup.kind === "missing")
  ) {
    throw new Error(
      "SQLite event import cannot scope a multi-Workspace source without workspace_id on activity, issues, and teams",
    );
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
    hasWorkspaceTable: workspaceTable !== undefined,
    hasScopedMetadata,
    scopedTables,
    workspaceMembershipMetadata: membershipMetadata,
    actorWorkspaceIds:
      uniqueAmbiguousTables.length > 0 ? new Map() : actorWorkspaceIndex.actorWorkspaceIds,
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
                 activity.issue_id AS source_issue_id,
                 activity.actor_id AS source_actor_id,
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
    const scopeDecision = activityScopeDecision(row, scope);
    if (scopeDecision.kind !== "valid") {
      const finding = scopeDecision.kind;
      if (finding === "orphaned") orphaned += 1;
      else if (finding === "outOfScope") outOfScope += 1;
      else ambiguous += 1;
      warning(warnings, finding === "outOfScope" ? "out_of_scope" : finding, row.id);
      continue;
    }
    const rowWorkspaceId = scopeDecision.workspaceId;

    const actor = row.actor_id ?? row.actor;
    if (!row.issue_identifier || !actor || !row.issue_id || !row.team_id) {
      orphaned += 1;
      warning(warnings, "orphaned", row.id);
      continue;
    }
    // Un esquema legacy singleton o un selector explícito aportan el Workspace
    // para filas anteriores a workspace_id. Una fuente multi-Workspace sin
    // selector ya fue rechazada antes de llegar a este punto.
    const eventWorkspaceId = rowWorkspaceId ?? scope.workspaceId;
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
