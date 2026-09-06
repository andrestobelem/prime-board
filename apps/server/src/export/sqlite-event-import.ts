import type { Database } from "bun:sqlite";
import { EventLogWriter, type DomainEvent } from "./event-log.ts";
import {
  areActivityEventsEquivalent,
  activityToDomainEvent,
  type ActivityEventRow,
} from "./activity-stream.ts";

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

interface ImportScope {
  readonly workspaceId: string | undefined;
  readonly workspaceIds: ReadonlySet<string>;
  readonly multipleWorkspaces: boolean;
  readonly activityHasWorkspace: boolean;
  readonly issueHasWorkspace: boolean;
  readonly teamHasWorkspace: boolean;
}

function warning(warnings: string[], kind: string, id: string): void {
  if (warnings.length < 100) warnings.push(`${kind}:${id}`);
}

function hasTable(db: Database, table: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1").get(table) !=
    null
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (entry) => entry.name === column,
  );
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
  const workspaceTable = hasTable(db, "workspace");
  if (requestedWorkspaceId !== undefined && !workspaceTable) {
    throw new Error("SQLite event import workspaceId requires a workspace table");
  }

  const workspaceIds = workspaceTable
    ? (db.query("SELECT id FROM workspace ORDER BY id").all() as Array<{ id: string }>).map(
        (row) => row.id,
      )
    : [];
  if (workspaceTable && workspaceIds.length === 0) {
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

  const activityHasWorkspace = hasColumn(db, "activity", "workspace_id");
  const issueHasWorkspace = hasColumn(db, "issues", "workspace_id");
  const teamHasWorkspace = hasColumn(db, "teams", "workspace_id");
  if (multipleWorkspaces && (!activityHasWorkspace || !issueHasWorkspace || !teamHasWorkspace)) {
    throw new Error(
      "SQLite event import cannot scope a multi-Workspace source without workspace_id on activity, issues, and teams",
    );
  }

  return {
    workspaceId: requestedWorkspaceId ?? workspaceIds[0],
    workspaceIds: new Set(workspaceIds),
    multipleWorkspaces,
    activityHasWorkspace,
    issueHasWorkspace,
    teamHasWorkspace,
  };
}

function activityQuery(scope: ImportScope): string {
  const activityWorkspace = scope.activityHasWorkspace
    ? "activity.workspace_id AS activity_workspace_id"
    : "NULL AS activity_workspace_id";
  const issueWorkspace = scope.issueHasWorkspace
    ? "issues.workspace_id AS issue_workspace_id"
    : "NULL AS issue_workspace_id";
  const teamWorkspace = scope.teamHasWorkspace
    ? "teams.workspace_id AS team_workspace_id"
    : "NULL AS team_workspace_id";
  const issueJoin =
    scope.activityHasWorkspace && scope.issueHasWorkspace
      ? scope.multipleWorkspaces
        ? "LEFT JOIN issues ON issues.id = activity.issue_id AND activity.workspace_id IS NOT NULL AND issues.workspace_id = activity.workspace_id"
        : "LEFT JOIN issues ON issues.id = activity.issue_id AND (activity.workspace_id IS NULL OR issues.workspace_id = activity.workspace_id)"
      : "LEFT JOIN issues ON issues.id = activity.issue_id";
  const teamJoin =
    scope.issueHasWorkspace && scope.teamHasWorkspace
      ? scope.multipleWorkspaces
        ? "LEFT JOIN teams ON teams.id = issues.team_id AND issues.workspace_id IS NOT NULL AND teams.workspace_id = issues.workspace_id"
        : "LEFT JOIN teams ON teams.id = issues.team_id AND (issues.workspace_id IS NULL OR teams.workspace_id = issues.workspace_id)"
      : "LEFT JOIN teams ON teams.id = issues.team_id";
  return `SELECT activity.id,
                 teams.key || '-' || issues.number AS issue_identifier,
                 actors.id AS actor_id,
                 actors.name AS actor,
                 issues.id AS issue_id,
                 teams.id AS team_id,
                 ${activityWorkspace},
                 ${issueWorkspace},
                 ${teamWorkspace},
                 activity.type,
                 activity.payload,
                 activity.created_at AS occurred_at
          FROM activity
          ${issueJoin}
          ${teamJoin}
          LEFT JOIN actors ON actors.id = activity.actor_id
          ORDER BY activity.created_at, activity.id`;
}

/**
 * Importa la historia durable disponible en Activity de SQLite al stream
 * canónico. No lee logs históricos por Issue ni se conecta a PostgreSQL.
 * Una fuente multi-Workspace siempre exige un selector explícito de Workspace.
 */
export function importSqliteActivity(options: SQLiteEventImportOptions): SQLiteEventImportResult {
  const scope = resolveImportScope(options.db, options.workspaceId);
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
    const rows = options.db.query("SELECT id FROM activity").all() as Array<{ id: string }>;
    return {
      status: "completed",
      scanned: rows.length,
      emitted: 0,
      duplicates: 0,
      orphaned: rows.length,
      outOfScope: 0,
      rejected: 0,
      ambiguous: 0,
      warnings: rows.slice(0, 100).map((row) => `orphaned:activity:${row.id}`),
    };
  }
  const rows = options.db.query(activityQuery(scope)).all() as ActivityRow[];

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

    const actor = row.actor_id ?? row.actor;
    if (!row.issue_identifier || !actor || !row.issue_id || !row.team_id) {
      orphaned += 1;
      warning(warnings, "orphaned", row.id);
      continue;
    }
    const event = activityToDomainEvent({
      id: row.id,
      issue_identifier: row.issue_identifier,
      issue_id: row.issue_id ?? undefined,
      actor_id: row.actor_id ?? undefined,
      actor,
      type: row.type,
      payload: row.payload,
      workspace_id: rowWorkspaceId,
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
