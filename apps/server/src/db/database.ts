// Apertura de la base SQLite (WAL) y corrida de migraciones versionadas.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import migration0001 from "./migrations/0001_init.sql" with { type: "text" };
import migration0002 from "./migrations/0002_project_teams.sql" with { type: "text" };
import migration0003 from "./migrations/0003_milestones.sql" with { type: "text" };
import migration0004 from "./migrations/0004_issue_relations.sql" with { type: "text" };
import migration0005 from "./migrations/0005_team_default_state.sql" with { type: "text" };
import migration0006 from "./migrations/0006_saved_views.sql" with { type: "text" };
import migration0007 from "./migrations/0007_cycles.sql" with { type: "text" };
import migration0008 from "./migrations/0008_reviews.sql" with { type: "text" };
import migration0009 from "./migrations/0009_initiatives.sql" with { type: "text" };
import migration0010 from "./migrations/0010_project_updates.sql" with { type: "text" };
import migration0011 from "./migrations/0011_saved_view_archive_columns.sql" with { type: "text" };
import migration0012 from "./migrations/0012_inbox_receipts.sql" with { type: "text" };
import migration0013 from "./migrations/0013_initiative_owner.sql" with { type: "text" };
import migration0014 from "./migrations/0014_team_memberships.sql" with { type: "text" };
import migration0015 from "./migrations/0015_actor_workspace_roles.sql" with { type: "text" };
import migration0016 from "./migrations/0016_webhook_ownership.sql" with { type: "text" };
import migration0017 from "./migrations/0017_favorites.sql" with { type: "text" };
import migration0018 from "./migrations/0018_team_archive.sql" with { type: "text" };
import migration0019 from "./migrations/0019_actor_access_lifecycle.sql" with { type: "text" };
import migration0020 from "./migrations/0020_api_key_scopes.sql" with { type: "text" };
import migration0021 from "./migrations/0021_api_key_team_limits_restrict.sql" with { type: "text" };
import migration0022 from "./migrations/0022_team_visibility.sql" with { type: "text" };
import migration0023 from "./migrations/0023_webhook_team_scope.sql" with { type: "text" };
import migration0024 from "./migrations/0024_workspace_roots.sql" with { type: "text" };
import migration0025 from "./migrations/0025_workspace_constraints.sql" with { type: "text" };
import migration0026 from "./migrations/0026_api_key_workspaces.sql" with { type: "text" };
import migration0027 from "./migrations/0027_documents.sql" with { type: "text" };
import migration0028 from "./migrations/0028_issue_subscribers.sql" with { type: "text" };
import migration0029 from "./migrations/0029_comments_fts.sql" with { type: "text" };
import migration0030 from "./migrations/0030_documents_retirement.sql" with { type: "text" };
// PRB-382 es dueño de la migración 0031 (UserSettings); las notificaciones usan una tabla separada.
import migration0032 from "./migrations/0032_notification_preferences.sql" with { type: "text" };
import migration0033 from "./migrations/0033_views_preferences.sql" with { type: "text" };
import { verifyDocumentRows } from "../export/documents-archive.ts";
import { newId, now } from "./util.ts";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: "init", sql: migration0001 },
  { version: 2, name: "project_teams", sql: migration0002 },
  { version: 3, name: "milestones", sql: migration0003 },
  { version: 4, name: "issue_relations", sql: migration0004 },
  { version: 5, name: "team_default_state", sql: migration0005 },
  { version: 6, name: "saved_views", sql: migration0006 },
  { version: 7, name: "cycles", sql: migration0007 },
  { version: 8, name: "reviews", sql: migration0008 },
  { version: 9, name: "initiatives", sql: migration0009 },
  { version: 10, name: "project_updates", sql: migration0010 },
  { version: 11, name: "saved_view_archive_columns", sql: migration0011 },
  { version: 12, name: "inbox_receipts", sql: migration0012 },
  { version: 13, name: "initiative_owner", sql: migration0013 },
  { version: 14, name: "team_memberships", sql: migration0014 },
  { version: 15, name: "actor_workspace_roles", sql: migration0015 },
  { version: 16, name: "webhook_ownership", sql: migration0016 },
  { version: 17, name: "favorites", sql: migration0017 },
  { version: 18, name: "team_archive", sql: migration0018 },
  { version: 19, name: "actor_access_lifecycle", sql: migration0019 },
  { version: 20, name: "api_key_scopes", sql: migration0020 },
  { version: 21, name: "api_key_team_limits_restrict", sql: migration0021 },
  { version: 22, name: "team_visibility", sql: migration0022 },
  { version: 23, name: "webhook_team_scope", sql: migration0023 },
  { version: 24, name: "workspace_roots", sql: migration0024 },
  { version: 25, name: "workspace_constraints", sql: migration0025 },
  { version: 26, name: "api_key_workspaces", sql: migration0026 },
  { version: 27, name: "documents", sql: migration0027 },
  { version: 28, name: "issue_subscribers", sql: migration0028 },
  { version: 29, name: "comments_fts", sql: migration0029 },
  { version: 30, name: "documents_retirement", sql: migration0030 },
  // PRB-386 ya aplicó esta versión en bases existentes. No la renumeres.
  { version: 32, name: "notification_preferences", sql: migration0032 },
  { version: 33, name: "views_preferences", sql: migration0033 },
];

const WORKSPACE_ROOT_TABLES = [
  "teams",
  "projects",
  "issues",
  "labels",
  "webhooks",
  "saved_views",
  "cycles",
  "reviews",
  "initiatives",
  "project_updates",
  "actor_invitations",
] as const;

function countRows(db: Database, table: string): number {
  const row = db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function normalizeBackfilledMembershipIds(db: Database): void {
  const memberships = db
    .query("SELECT id FROM workspace_memberships WHERE instr(id, ':') > 0 ORDER BY id")
    .values() as Array<[string]>;
  const update = db.query("UPDATE workspace_memberships SET id = ?1 WHERE id = ?2");
  for (const [legacyId] of memberships) {
    // SQL mantiene el backfill determinista hasta que el runner puede usar el
    // generador UUID v7 del repositorio. Las Memberships son identidades nuevas;
    // no se modifica ninguna PK existente del dominio.
    update.run(newId(), legacyId);
  }
}

function validateWorkspaceMigration(db: Database, phase: "before" | "after"): void {
  const workspaceCount = countRows(db, "workspace");
  if (phase === "before") {
    if (workspaceCount > 1) {
      throw new Error(
        "Workspace migration cannot backfill a database with more than one Workspace",
      );
    }
    if (workspaceCount === 0) {
      const populated = WORKSPACE_ROOT_TABLES.find((table) => countRows(db, table) > 0);
      if (populated) {
        throw new Error(`Workspace migration cannot backfill ${populated} without a Workspace`);
      }
    }
    const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error("Workspace migration requires a valid legacy foreign-key graph");
    }
    return;
  }

  if (workspaceCount === 0) {
    const populated = WORKSPACE_ROOT_TABLES.find((table) => countRows(db, table) > 0);
    if (populated) {
      throw new Error(`Workspace migration left ${populated} without a Workspace`);
    }
  } else if (workspaceCount === 1) {
    const unscoped = WORKSPACE_ROOT_TABLES.find((table) => {
      const row = db
        .query(
          `SELECT count(*) AS count FROM ${table}
           WHERE workspace_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id = ${table}.workspace_id)`,
        )
        .get() as { count: number };
      return row.count > 0;
    });
    if (unscoped) {
      throw new Error(`Workspace migration did not backfill ${unscoped}`);
    }

    const actors = countRows(db, "actors");
    const memberships = countRows(db, "workspace_memberships");
    if (memberships !== actors) {
      throw new Error(
        `Workspace migration created ${memberships} Memberships for ${actors} Actors`,
      );
    }
  }

  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new Error("Workspace migration produced foreign-key violations");
  }
}

function validateApiKeyWorkspaceMigration(db: Database, phase: "before" | "after"): void {
  const workspaceCount = countRows(db, "workspace");
  if (phase === "before") {
    // La migración de constraints ya añadió workspace_id a los límites. Esta
    // etapa valida grants y límites después de añadir la tabla de grants.
    return;
  }
  const unscopedLimit = db
    .query("SELECT count(*) AS count FROM api_key_team_limits WHERE workspace_id IS NULL")
    .get() as { count: number };
  if (workspaceCount > 1 && unscopedLimit.count > 0) {
    throw new Error("API key team limits cannot be backfilled with multiple Workspaces");
  }
  if (phase === "after") {
    if (workspaceCount === 1 && unscopedLimit.count > 0) {
      throw new Error("API key team limits remain outside the Workspace");
    }
    if (workspaceCount === 1) {
      const missingGrant = db
        .query(
          "SELECT count(*) AS count FROM api_keys WHERE NOT EXISTS (SELECT 1 FROM api_key_workspaces WHERE api_key_id = api_keys.id)",
        )
        .get() as { count: number };
      if (missingGrant.count > 0) {
        throw new Error("API key Workspace grant backfill is incomplete");
      }
    }
  }
  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new Error("API key Workspace migration produced foreign-key violations");
  }
}

function hardenDatabaseFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

export interface DatabaseOptions {
  /** Archivo externo ya verificado antes de retirar Documents. */
  documentsArchivePath?: string;
}

export interface MigrationOptions extends DatabaseOptions {}

function documentArchivePath(options: DatabaseOptions): string | undefined {
  const configured = options.documentsArchivePath ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
  const trimmed = configured?.trim();
  return trimmed ? trimmed : undefined;
}

function activeDocuments(db: Database): Array<Record<string, unknown>> | null {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents' LIMIT 1")
    .get() as { name?: string } | null;
  if (!table) return null;
  return db.query("SELECT * FROM documents ORDER BY id").all() as Array<Record<string, unknown>>;
}

/**
 * Las migraciones históricas crean Documents para conservar su registro. Antes
 * de ejecutar la migración de retiro, exige un archivo externo cuyo manifest
 * coincida exactamente con las filas actuales. Nunca escribe ni elimina datos
 * durante esta comprobación.
 */
function verifyDocumentsBeforeRetirement(db: Database, options: MigrationOptions): void {
  const rows = activeDocuments(db);
  if (!rows?.length) return;
  const archivePath = documentArchivePath(options);
  if (!archivePath) {
    throw new Error(
      "Cannot retire Documents with data: provide PRIME_BOARD_DOCUMENTS_ARCHIVE after running archive-documents",
    );
  }
  try {
    verifyDocumentRows(rows, archivePath, "sqlite");
  } catch (error) {
    throw new Error(
      `Cannot retire Documents safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function openDatabase(path: string, options: DatabaseOptions = {}): Database {
  if (path !== ":memory:") {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Una ruta relativa puede usar el directorio de trabajo del proceso. No cambies
    // los permisos de ese directorio compartido; la DB y los archivos WAL siguen privados.
    if (directory !== ".") chmodSync(directory, 0o700);
  }
  const db = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") hardenDatabaseFiles(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") hardenDatabaseFiles(path);
  migrate(db, options);
  if (path !== ":memory:") hardenDatabaseFiles(path);
  return db;
}

function validateWorkspaceConstraints(db: Database): void {
  const violations = db.query("PRAGMA foreign_key_check").all() as Array<{
    table?: string;
    rowid?: number;
    parent?: string;
  }>;
  if (violations.length > 0) {
    const first = violations[0];
    throw new Error(
      `Workspace constraints found a cross-Workspace reference in ${first?.table ?? "unknown table"}`,
    );
  }
}

const SAVED_VIEWS_MIGRATION_COLUMNS = [
  "id",
  "name",
  "scope",
  "team_id",
  "owner_id",
  "filter_json",
  "order_by",
  "group_by",
  "created_at",
  "updated_at",
  "archived_at",
  "columns_json",
  "workspace_id",
];

interface SavedViewsForeignKeyColumn {
  from: string;
  to: string;
}

interface SavedViewsForeignKeyDefinition {
  table: string;
  columns: readonly SavedViewsForeignKeyColumn[];
  onUpdate: string;
  onDelete: string;
  match?: string;
}

interface SavedViewsForeignKeyRow extends SavedViewsForeignKeyColumn {
  id: number;
  seq: number;
  table: string;
  on_update: string;
  on_delete: string;
  match: string;
}

const SAVED_VIEWS_REQUIRED_FOREIGN_KEYS = [
  {
    table: "actors",
    columns: [{ from: "owner_id", to: "id" }],
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
    match: "NONE",
  },
  {
    table: "workspace",
    columns: [{ from: "workspace_id", to: "id" }],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    match: "NONE",
  },
  {
    table: "teams",
    columns: [
      { from: "workspace_id", to: "workspace_id" },
      { from: "team_id", to: "id" },
    ],
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
    match: "NONE",
  },
] satisfies readonly SavedViewsForeignKeyDefinition[];

const VIEWS_MIGRATION_REQUIRED_INDEXES = [
  { table: "saved_views", columns: ["workspace_id", "id"], unique: true },
  { table: "saved_views", columns: ["scope", "team_id"], unique: false },
  { table: "saved_views", columns: ["owner_id"], unique: false },
  { table: "workspace_memberships", columns: ["workspace_id", "actor_id"], unique: true },
  { table: "teams", columns: ["workspace_id", "id"], unique: true },
  { table: "projects", columns: ["workspace_id", "id"], unique: true },
  { table: "initiatives", columns: ["workspace_id", "id"], unique: true },
];

const VIEWS_MIGRATION_REQUIRED_TABLES = [
  "actors",
  "workspace",
  "teams",
  "projects",
  "initiatives",
  "workspace_memberships",
];

interface ColumnContract {
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKey: number;
}

const LEGACY_SAVED_VIEWS_COLUMN_CONTRACT = [
  { name: "id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 1 },
  { name: "name", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "scope", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "team_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "owner_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "filter_json", type: "TEXT", notNull: 1, defaultValue: "'{}'", primaryKey: 0 },
  { name: "order_by", type: "TEXT", notNull: 1, defaultValue: "'CREATED_DESC'", primaryKey: 0 },
  { name: "group_by", type: "TEXT", notNull: 1, defaultValue: "'state'", primaryKey: 0 },
  { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "archived_at", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "columns_json", type: "TEXT", notNull: 1, defaultValue: "'[]'", primaryKey: 0 },
  { name: "workspace_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
] satisfies readonly ColumnContract[];

const SAVED_VIEWS_TARGET_COLUMN_CONTRACT = [
  { name: "id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 1 },
  { name: "name", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "scope", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "team_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "project_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "initiative_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "owner_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "filter_json", type: "TEXT", notNull: 1, defaultValue: "'{}'", primaryKey: 0 },
  { name: "order_by", type: "TEXT", notNull: 1, defaultValue: "'CREATED_DESC'", primaryKey: 0 },
  { name: "group_by", type: "TEXT", notNull: 1, defaultValue: "'state'", primaryKey: 0 },
  { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "archived_at", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "columns_json", type: "TEXT", notNull: 1, defaultValue: "'[]'", primaryKey: 0 },
  { name: "workspace_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
] satisfies readonly ColumnContract[];

const VIEW_PREFERENCES_COLUMN_CONTRACT = [
  { name: "id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 1 },
  { name: "workspace_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "view_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "actor_id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 0 },
  { name: "view_type", type: "TEXT", notNull: 1, defaultValue: "'issue'", primaryKey: 0 },
  { name: "scope", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "layout", type: "TEXT", notNull: 1, defaultValue: "'list'", primaryKey: 0 },
  { name: "order_by", type: "TEXT", notNull: 1, defaultValue: "'UPDATED_DESC'", primaryKey: 0 },
  { name: "group_by", type: "TEXT", notNull: 1, defaultValue: "'state'", primaryKey: 0 },
  { name: "columns_json", type: "TEXT", notNull: 1, defaultValue: "'[]'", primaryKey: 0 },
  { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
] satisfies readonly ColumnContract[];

const VIEW_SUBSCRIPTIONS_COLUMN_CONTRACT = [
  { name: "id", type: "TEXT", notNull: 0, defaultValue: null, primaryKey: 1 },
  { name: "workspace_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "view_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "actor_id", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "issue_changes", type: "INTEGER", notNull: 1, defaultValue: "1", primaryKey: 0 },
  { name: "slack", type: "INTEGER", notNull: 1, defaultValue: "0", primaryKey: 0 },
  { name: "created_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
  { name: "updated_at", type: "TEXT", notNull: 1, defaultValue: null, primaryKey: 0 },
] satisfies readonly ColumnContract[];

const NOTIFICATION_PREFERENCES_COLUMNS = [
  "workspace_id",
  "actor_id",
  "category",
  "channel",
  "enabled",
  "email_delivery",
  "created_at",
  "updated_at",
];

interface MigrationMarkerRow {
  version: number;
  name: string;
  applied_at: string;
}

interface IndexListRow {
  name: string;
  unique_value: number;
  origin: string;
  partial: number;
}

interface IndexTermRow {
  seqno: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

/**
 * SQLite no conserva SQL para los índices de PRIMARY KEY/UNIQUE de tabla.
 * Los términos de PRAGMA son la representación canónica que permite
 * reconstruir una unicidad arbitraria sin interpolar SQL legacy.
 */
interface SavedViewsIndexDefinition extends IndexListRow {
  sql: string | null;
  terms: readonly IndexTermRow[];
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SqlDefinitionRow {
  sql: string | null;
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface ViewsMigrationIndexArtifact {
  table: string;
  name: string;
  columns: readonly string[];
  unique: boolean;
}

const VIEWS_MIGRATION_ARTIFACT_TABLES = [
  "view_preferences",
  "view_subscriptions",
  "_prb390_saved_views",
] satisfies readonly string[];

const VIEWS_MIGRATION_ARTIFACT_INDEXES = [
  {
    table: "view_preferences",
    name: "idx_view_preferences_view",
    columns: ["workspace_id", "view_id"],
    unique: false,
  },
  {
    table: "view_preferences",
    name: "idx_view_preferences_actor",
    columns: ["workspace_id", "actor_id"],
    unique: false,
  },
  {
    table: "view_subscriptions",
    name: "idx_view_subscriptions_view",
    columns: ["workspace_id", "view_id"],
    unique: false,
  },
  {
    table: "view_subscriptions",
    name: "idx_view_subscriptions_actor",
    columns: ["workspace_id", "actor_id"],
    unique: false,
  },
] satisfies readonly ViewsMigrationIndexArtifact[];

const SAVED_VIEWS_TARGET_FOREIGN_KEYS = [
  ...SAVED_VIEWS_REQUIRED_FOREIGN_KEYS,
  {
    table: "projects",
    columns: [
      { from: "workspace_id", to: "workspace_id" },
      { from: "project_id", to: "id" },
    ],
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
    match: "NONE",
  },
  {
    table: "initiatives",
    columns: [
      { from: "workspace_id", to: "workspace_id" },
      { from: "initiative_id", to: "id" },
    ],
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
    match: "NONE",
  },
] satisfies readonly SavedViewsForeignKeyDefinition[];

const VIEW_PREFERENCES_REQUIRED_FOREIGN_KEYS = [
  {
    table: "workspace",
    columns: [{ from: "workspace_id", to: "id" }],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    match: "NONE",
  },
  {
    table: "saved_views",
    columns: [
      { from: "workspace_id", to: "workspace_id" },
      { from: "view_id", to: "id" },
    ],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    match: "NONE",
  },
  {
    table: "workspace_memberships",
    columns: [
      { from: "workspace_id", to: "workspace_id" },
      { from: "actor_id", to: "actor_id" },
    ],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    match: "NONE",
  },
] satisfies readonly SavedViewsForeignKeyDefinition[];

const VIEW_SUBSCRIPTIONS_REQUIRED_FOREIGN_KEYS = [
  {
    table: "saved_views",
    columns: [
      { from: "workspace_id", to: "workspace_id" },
      { from: "view_id", to: "id" },
    ],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    match: "NONE",
  },
  {
    table: "workspace_memberships",
    columns: [
      { from: "workspace_id", to: "workspace_id" },
      { from: "actor_id", to: "actor_id" },
    ],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    match: "NONE",
  },
] satisfies readonly SavedViewsForeignKeyDefinition[];

const VIEWS_MIGRATION_CHECKS = {
  saved_views: [
    "scope IN ('personal', 'team', 'workspace', 'project', 'initiative')",
    "(scope = 'team' AND team_id IS NOT NULL AND project_id IS NULL AND initiative_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL AND team_id IS NULL AND initiative_id IS NULL) OR (scope = 'initiative' AND initiative_id IS NOT NULL AND team_id IS NULL AND project_id IS NULL) OR (scope IN ('personal', 'workspace') AND team_id IS NULL AND project_id IS NULL AND initiative_id IS NULL)",
  ],
  view_preferences: [
    "view_type IN ('issue', 'project', 'initiative', 'feed')",
    "scope IN ('actor', 'workspace')",
    "layout IN ('list', 'board')",
    "order_by IN ('CREATED_ASC', 'CREATED_DESC', 'UPDATED_ASC', 'UPDATED_DESC')",
    "group_by IN ('state', 'milestone', 'assignee', 'priority')",
    "(scope = 'actor' AND actor_id IS NOT NULL) OR (scope = 'workspace' AND actor_id IS NULL)",
  ],
  view_subscriptions: [
    "issue_changes IN (0, 1)",
    "slack IN (0, 1)",
    "issue_changes = 1 OR slack = 1",
  ],
} satisfies Record<string, readonly string[]>;

const LEGACY_SAVED_VIEWS_CHECKS = [
  "scope IN ('personal', 'team', 'workspace')",
  "(scope = 'team' AND team_id IS NOT NULL) OR (scope != 'team' AND team_id IS NULL)",
] satisfies readonly string[];

const VIEWS_MIGRATION_UNIQUE_CONSTRAINTS = {
  saved_views: ["workspace_id", "id"],
  view_preferences: ["workspace_id", "id"],
  view_subscriptions: ["workspace_id", "view_id", "actor_id"],
} satisfies Record<string, readonly string[]>;

function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
  );
}

function schemaObjects(db: Database, name: string): SchemaObjectRow[] {
  return db
    .query<SchemaObjectRow, SQLQueryBindings[]>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE lower(name) = lower(?1) ORDER BY type, name",
    )
    .all(name);
}

function indexNameInUse(db: Database, name: string): boolean {
  // SQLite permite compartir el nombre entre un índice y un trigger. Los
  // demás objetos del esquema reservan el nombre para un índice.
  return schemaObjects(db, name).some((object) => object.type !== "trigger");
}

function tableInfo(db: Database, table: string): TableInfoRow[] {
  return db
    .query<TableInfoRow, SQLQueryBindings[]>(
      'SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?1) ORDER BY cid',
    )
    .all(table);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return tableInfo(db, table).some((value) => value.name === column);
}

function indexList(db: Database, table: string): IndexListRow[] {
  return db
    .query<IndexListRow, SQLQueryBindings[]>(
      'SELECT name, "unique" AS unique_value, origin, partial FROM pragma_index_list(?1) ORDER BY seq',
    )
    .all(table);
}

function indexTerms(db: Database, name: string): IndexTermRow[] {
  return db
    .query<IndexTermRow, SQLQueryBindings[]>(
      "SELECT seqno, name, desc, coll, key FROM pragma_index_xinfo(?1) WHERE key = 1 ORDER BY seqno",
    )
    .all(name);
}

function indexHasColumns(
  index: IndexListRow,
  terms: readonly IndexTermRow[],
  columns: readonly string[],
  unique: boolean,
): boolean {
  return (
    index.unique_value === (unique ? 1 : 0) &&
    index.partial === 0 &&
    terms.length === columns.length &&
    terms.every(
      (term, position) =>
        term.seqno === position &&
        term.name === columns[position] &&
        term.desc === 0 &&
        term.coll === "BINARY",
    )
  );
}

function hasNamedIndexWithColumns(
  db: Database,
  table: string,
  name: string,
  columns: readonly string[],
  unique: boolean,
): boolean {
  const index = indexList(db, table).find((value) => value.name === name);
  return Boolean(index && indexHasColumns(index, indexTerms(db, name), columns, unique));
}

function hasIndexWithColumns(
  db: Database,
  table: string,
  columns: readonly string[],
  unique: boolean,
): boolean {
  return indexList(db, table).some((index) =>
    indexHasColumns(index, indexTerms(db, index.name), columns, unique),
  );
}

function hasUniqueConstraintWithColumns(
  db: Database,
  table: string,
  columns: readonly string[],
): boolean {
  return indexList(db, table).some(
    (index) =>
      index.origin === "u" && indexHasColumns(index, indexTerms(db, index.name), columns, true),
  );
}

function hasPrimaryKeyColumns(db: Database, table: string, columns: readonly string[]): boolean {
  const primaryKeyColumns = tableInfo(db, table).filter((column) => column.pk > 0);
  return (
    primaryKeyColumns.length === columns.length &&
    primaryKeyColumns.every((column, position) => {
      const expected = columns[position];
      return expected !== undefined && column.pk === position + 1 && column.name === expected;
    })
  );
}

function hasNamedIndex(db: Database, table: string, name: string): boolean {
  return indexList(db, table).some((index) => index.name === name);
}

function hasTrigger(db: Database, name: string): boolean {
  return Boolean(
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?1 LIMIT 1").get(name),
  );
}

function normalizedSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, "");
}

type SqlTokenKind =
  "identifier" | "quoted_identifier" | "string" | "number" | "operator" | "punctuation";

interface SqlToken {
  kind: SqlTokenKind;
  value: string;
  start: number;
  end: number;
}

function pushSqlToken(
  tokens: SqlToken[],
  kind: SqlTokenKind,
  value: string,
  start: number,
  end: number,
): void {
  tokens.push({ kind, value, start, end });
}

function isSqlIdentifierStart(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    (codePoint !== undefined && codePoint >= 0x80) ||
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    character === "_"
  );
}

function isSqlIdentifierPart(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    isSqlIdentifierStart(character) || (character >= "0" && character <= "9") || character === "$"
  );
}

function sqliteTokens(sql: string): SqlToken[] | null {
  const tokens: SqlToken[] = [];
  let position = 0;

  while (position < sql.length) {
    const character = sql[position];
    const next = sql[position + 1];
    if (character === undefined) break;

    if (/\s/.test(character)) {
      position += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      position += 2;
      while (position < sql.length && sql[position] !== "\n") position += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", position + 2);
      if (end < 0) return null;
      position = end + 2;
      continue;
    }

    if (character === "'") {
      const start = position;
      position += 1;
      let closed = false;
      while (position < sql.length) {
        if (sql[position] !== "'") {
          position += 1;
          continue;
        }
        if (sql[position + 1] === "'") {
          position += 2;
          continue;
        }
        position += 1;
        closed = true;
        break;
      }
      if (!closed) return null;
      pushSqlToken(tokens, "string", sql.slice(start, position), start, position);
      continue;
    }

    if (character === '"' || character === "`") {
      const quote = character;
      const start = position;
      position += 1;
      let closed = false;
      while (position < sql.length) {
        if (sql[position] !== quote) {
          position += 1;
          continue;
        }
        if (sql[position + 1] === quote) {
          position += 2;
          continue;
        }
        position += 1;
        closed = true;
        break;
      }
      if (!closed) return null;
      const quoted = sql.slice(start + 1, position - 1);
      pushSqlToken(
        tokens,
        "quoted_identifier",
        quoted.replaceAll(quote + quote, quote),
        start,
        position,
      );
      continue;
    }

    if (character === "[") {
      const end = sql.indexOf("]", position + 1);
      if (end < 0) return null;
      pushSqlToken(tokens, "quoted_identifier", sql.slice(position + 1, end), position, end + 1);
      position = end + 1;
      continue;
    }

    if (
      (character >= "0" && character <= "9") ||
      (character === "." && next !== undefined && next >= "0" && next <= "9")
    ) {
      const start = position;
      if (character === "0" && (next === "x" || next === "X")) {
        position += 2;
        while (position < sql.length && /[0-9a-fA-F]/.test(sql[position] ?? "")) position += 1;
      } else {
        while (position < sql.length && /[0-9]/.test(sql[position] ?? "")) position += 1;
        if (sql[position] === ".") {
          position += 1;
          while (position < sql.length && /[0-9]/.test(sql[position] ?? "")) position += 1;
        }
        if (sql[position] === "e" || sql[position] === "E") {
          const exponentStart = position;
          position += 1;
          if (sql[position] === "+" || sql[position] === "-") position += 1;
          const digitsStart = position;
          while (position < sql.length && /[0-9]/.test(sql[position] ?? "")) position += 1;
          if (digitsStart === position) position = exponentStart;
        }
      }
      pushSqlToken(tokens, "number", sql.slice(start, position), start, position);
      continue;
    }

    if (isSqlIdentifierStart(character)) {
      const start = position;
      position += 1;
      while (position < sql.length && isSqlIdentifierPart(sql[position] ?? "")) position += 1;
      pushSqlToken(tokens, "identifier", sql.slice(start, position), start, position);
      continue;
    }

    const operator = ["->>", "<<", ">>", "||", "<=", ">=", "<>", "!=", "==", "->"].find(
      (candidate) => sql.startsWith(candidate, position),
    );
    if (operator) {
      pushSqlToken(tokens, "operator", operator, position, position + operator.length);
      position += operator.length;
      continue;
    }

    if ("~!%^&*+-/=<>|".includes(character)) {
      pushSqlToken(tokens, "operator", character, position, position + 1);
    } else {
      pushSqlToken(tokens, "punctuation", character, position, position + 1);
    }
    position += 1;
  }

  return tokens;
}

function singleSqlStatement(tokens: readonly SqlToken[]): readonly SqlToken[] | null {
  const semicolon = tokens.findIndex((token) => token.value === ";");
  if (semicolon < 0) return tokens;
  return tokens.slice(semicolon + 1).length === 0 ? tokens.slice(0, semicolon) : null;
}

function comparableSqlToken(token: SqlToken): string {
  if (token.kind === "identifier" || token.kind === "quoted_identifier") {
    return `identifier:${token.value.toLowerCase()}`;
  }
  return `${token.kind}:${token.value}`;
}

function comparableSqlTokens(tokens: readonly SqlToken[]): string[] {
  return tokens.map(comparableSqlToken);
}

/**
 * Extrae solo tokens CHECK que SQLite puede interpretar como restricciones.
 * Los comentarios y literales son tokens indivisibles, por lo que nunca pueden
 * aportar una expresión falsa. La comprobación no pretende ser un parser SQL
 * general: EXPLAIN valida antes que la definición completa siga siendo ejecutable.
 * La comparación es canónica a nivel de tokens y no acepta reescrituras que solo
 * sean equivalentes por semántica. SQLite no expone CHECK mediante PRAGMA, por
 * eso la definición de sqlite_master se vuelve a compilar con un nombre temporal.
 */
function checkExpressionsFromDefinition(definition: string): SqlToken[][] | null {
  const parsed = sqliteTokens(definition);
  if (parsed === null) return null;
  const tokens = singleSqlStatement(parsed);
  if (tokens === null) return null;
  const expressions: SqlToken[][] = [];
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token?.kind !== "identifier" || token.value.toLowerCase() !== "check") {
      continue;
    }
    const opening = tokens[position + 1];
    if (opening?.value !== "(") continue;
    let depth = 1;
    for (let end = position + 2; end < tokens.length; end += 1) {
      const nested = tokens[end];
      if (nested?.value === "(") depth += 1;
      if (nested?.value !== ")") continue;
      depth -= 1;
      if (depth !== 0) continue;
      expressions.push(tokens.slice(position + 2, end));
      position = end;
      break;
    }
    if (depth !== 0) return null;
  }
  return expressions;
}

function definitionForExplain(definition: string): string | null {
  const parsed = sqliteTokens(definition);
  const tokens = parsed === null ? null : singleSqlStatement(parsed);
  if (
    !tokens ||
    tokens[0]?.kind !== "identifier" ||
    tokens[0].value.toLowerCase() !== "create" ||
    tokens[1]?.kind !== "identifier" ||
    tokens[1].value.toLowerCase() !== "table"
  ) {
    return null;
  }
  const opening = tokens.findIndex((token, position) => position > 1 && token.value === "(");
  if (opening < 0) return null;
  const tableToken = tokens[opening - 1];
  if (tableToken?.kind !== "identifier" && tableToken?.kind !== "quoted_identifier") {
    return null;
  }
  const probeName = "__prb641_check_probe";
  if (tableToken.value.toLowerCase() === probeName) return null;
  return `${definition.slice(0, tableToken.start)}${probeName}${definition.slice(tableToken.end)}`;
}

function executableTableDefinition(db: Database, definition: string): boolean {
  const explainable = definitionForExplain(definition);
  if (explainable === null) return false;
  try {
    const query = db.query(`EXPLAIN ${explainable}`);
    try {
      query.all();
      return true;
    } finally {
      query.finalize();
    }
  } catch {
    return false;
  }
}

interface ParsedIndexDefinition {
  name: string;
  table: string;
  unique: boolean;
  terms: readonly SqlToken[][];
}

function isSqlNameToken(token: SqlToken | undefined): token is SqlToken {
  return token?.kind === "identifier" || token?.kind === "quoted_identifier";
}

function isSqlKeyword(token: SqlToken | undefined, keyword: string): boolean {
  return token?.kind === "identifier" && token.value.toLowerCase() === keyword;
}

/**
 * Extrae el destino y los términos de un CREATE INDEX sin interpretar texto
 * dentro de comentarios o literales como SQL. Solo acepta una sentencia simple.
 */
function indexDefinitionFromSql(definition: string): ParsedIndexDefinition | null {
  const parsed = sqliteTokens(definition);
  if (parsed === null) return null;
  const tokens = singleSqlStatement(parsed);
  if (tokens === null) return null;

  let position = 0;
  if (!isSqlKeyword(tokens[position], "create")) return null;
  position += 1;

  const unique = isSqlKeyword(tokens[position], "unique");
  if (unique) position += 1;
  if (!isSqlKeyword(tokens[position], "index")) return null;
  position += 1;

  if (isSqlKeyword(tokens[position], "if")) {
    if (!isSqlKeyword(tokens[position + 1], "not")) return null;
    if (!isSqlKeyword(tokens[position + 2], "exists")) return null;
    position += 3;
  }

  const indexToken = tokens[position];
  const onToken = tokens[position + 1];
  const tableToken = tokens[position + 2];
  const opening = tokens[position + 3];
  if (
    !isSqlNameToken(indexToken) ||
    !isSqlKeyword(onToken, "on") ||
    !isSqlNameToken(tableToken) ||
    opening?.value !== "("
  ) {
    return null;
  }

  position += 4;
  const terms: SqlToken[][] = [];
  let termStart = position;
  let depth = 0;
  let closed = false;
  for (; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (!token) return null;
    if (token.value === "(") {
      depth += 1;
      continue;
    }
    if (token.value === ")") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      const term = tokens.slice(termStart, position);
      if (term.length === 0) return null;
      terms.push(term);
      closed = true;
      break;
    }
    if (token.value === "," && depth === 0) {
      const term = tokens.slice(termStart, position);
      if (term.length === 0) return null;
      terms.push(term);
      termStart = position + 1;
    }
  }

  if (!closed || position !== tokens.length - 1) return null;
  return {
    name: indexToken.value,
    table: tableToken.value,
    unique,
    terms,
  };
}

function renamedIndexSql(definition: string, name: string): string | null {
  const parsed = sqliteTokens(definition);
  if (parsed === null) return null;
  const tokens = singleSqlStatement(parsed);
  if (tokens === null) return null;

  let position = 0;
  if (!isSqlKeyword(tokens[position], "create")) return null;
  position += 1;
  if (isSqlKeyword(tokens[position], "unique")) position += 1;
  if (!isSqlKeyword(tokens[position], "index")) return null;
  position += 1;
  if (isSqlKeyword(tokens[position], "if")) {
    if (!isSqlKeyword(tokens[position + 1], "not")) return null;
    if (!isSqlKeyword(tokens[position + 2], "exists")) return null;
    position += 3;
  }

  const indexToken = tokens[position];
  const tableToken = tokens[position + 2];
  if (
    !isSqlNameToken(indexToken) ||
    !isSqlKeyword(tokens[position + 1], "on") ||
    !isSqlNameToken(tableToken) ||
    tableToken.value.toLowerCase() !== "saved_views"
  ) {
    return null;
  }
  return `${definition.slice(0, indexToken.start)}${quoteIdentifier(name)}${definition.slice(indexToken.end)}`;
}

const VIEW_PREFERENCES_KEY_INDEX_TERMS = [
  { sql: "workspace_id", column: "workspace_id" },
  { sql: "ifnull(view_id, '')", column: null },
  { sql: "view_type", column: "view_type" },
  { sql: "ifnull(actor_id, '')", column: null },
] satisfies readonly { sql: string; column: string | null }[];

function comparableSqlExpressions(expressions: readonly string[]): string[][] | null {
  const result: string[][] = [];
  for (const expression of expressions) {
    const tokens = sqliteTokens(expression);
    if (tokens === null) return null;
    result.push(comparableSqlTokens(tokens));
  }
  return result;
}

function sameSqlTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, position) => token === right[position]);
}

function hasViewPreferencesKeyIndex(db: Database): boolean {
  const index = indexList(db, "view_preferences").find(
    (value) => value.name === "idx_view_preferences_key",
  );
  if (!index || index.unique_value !== 1 || index.partial !== 0) return false;

  const definition = db
    .query<SqlDefinitionRow, SQLQueryBindings[]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
    )
    .get("idx_view_preferences_key");
  if (!definition?.sql) return false;

  const parsed = indexDefinitionFromSql(definition.sql);
  if (
    !parsed ||
    !parsed.unique ||
    parsed.name.toLowerCase() !== index.name.toLowerCase() ||
    parsed.table.toLowerCase() !== "view_preferences"
  ) {
    return false;
  }

  const expectedTerms = comparableSqlExpressions(
    VIEW_PREFERENCES_KEY_INDEX_TERMS.map((term) => term.sql),
  );
  if (expectedTerms === null || parsed.terms.length !== expectedTerms.length) return false;

  const actualTerms = indexTerms(db, index.name);
  if (actualTerms.length !== VIEW_PREFERENCES_KEY_INDEX_TERMS.length) return false;
  return actualTerms.every((term, position) => {
    const expected = VIEW_PREFERENCES_KEY_INDEX_TERMS[position];
    const expectedSql = expectedTerms[position];
    const actualSql = parsed.terms[position];
    return (
      expected !== undefined &&
      expectedSql !== undefined &&
      actualSql !== undefined &&
      term.seqno === position &&
      term.name === expected.column &&
      term.desc === 0 &&
      term.coll === "BINARY" &&
      sameSqlTokens(comparableSqlTokens(actualSql), expectedSql)
    );
  });
}

function savedViewsIndexDefinitions(db: Database): SavedViewsIndexDefinition[] {
  return indexList(db, "saved_views").map((index) => {
    const definition = db
      .query<SqlDefinitionRow, SQLQueryBindings[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
      )
      .get(index.name);
    return {
      ...index,
      sql: definition?.sql ?? null,
      terms: indexTerms(db, index.name),
    };
  });
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function equivalentIndex(
  db: Database,
  table: string,
  terms: readonly IndexTermRow[],
  unique: boolean,
  origin?: string,
  partial = 0,
): boolean {
  return indexList(db, table).some((index) => {
    if (origin !== undefined && index.origin !== origin) return false;
    const actualTerms = indexTerms(db, index.name);
    return (
      index.unique_value === (unique ? 1 : 0) &&
      index.partial === partial &&
      actualTerms.length === terms.length &&
      actualTerms.every((term, position) => {
        const expected = terms[position];
        return (
          expected !== undefined &&
          term.seqno === expected.seqno &&
          term.name === expected.name &&
          term.desc === expected.desc &&
          term.coll === expected.coll
        );
      })
    );
  });
}

function generatedLegacyIndexName(db: Database, terms: readonly IndexTermRow[]): string {
  const suffix =
    terms
      .map((term) => term.name ?? "expression")
      .join("_")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "") || "columns";
  const base = `idx_saved_views_legacy_unique_${suffix}`;
  if (!indexNameInUse(db, base)) return base;
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const candidate = `${base}_${suffixNumber}`;
    if (!indexNameInUse(db, candidate)) return candidate;
  }
}

function generatedSavedViewsIndexName(db: Database, name: string): string {
  const base = `${name}_legacy`;
  if (!indexNameInUse(db, base)) return base;
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const candidate = `${base}_${suffixNumber}`;
    if (!indexNameInUse(db, candidate)) return candidate;
  }
}

function savedViewsIndexProblems(definitions: readonly SavedViewsIndexDefinition[]): string[] {
  return definitions
    .filter(
      (definition) =>
        definition.sql === null &&
        (definition.partial !== 0 ||
          definition.terms.length === 0 ||
          definition.terms.some((term) => term.name === null)),
    )
    .map((definition) => `index ${definition.name} has no recoverable column definition`);
}

function restoreSavedViewsIndexes(
  db: Database,
  definitions: readonly SavedViewsIndexDefinition[],
): void {
  for (const definition of definitions) {
    // Las constraints de tabla llegan con sql=NULL y origin u/pk. Si la tabla
    // canónica ya provee ese índice, se conserva su contrato; las demás se
    // materializan como índices explícitos con columnas de PRAGMA.

    const unique = definition.unique_value === 1;
    if (
      equivalentIndex(db, "saved_views", definition.terms, unique, undefined, definition.partial)
    ) {
      continue;
    }
    if (definition.sql !== null) {
      const indexName = indexNameInUse(db, definition.name)
        ? generatedSavedViewsIndexName(db, definition.name)
        : definition.name;
      const sql =
        indexName === definition.name ? definition.sql : renamedIndexSql(definition.sql, indexName);
      if (sql === null) {
        throw new Error(`Cannot restore saved_views index ${definition.name} safely`);
      }
      db.exec(sql);
      continue;
    }

    if (definition.partial !== 0 || definition.terms.length === 0) {
      throw new Error(`Cannot restore saved_views index ${definition.name} safely`);
    }
    if (definition.terms.some((term) => term.name === null)) {
      throw new Error(`Cannot restore saved_views index ${definition.name} safely`);
    }

    const indexName = definition.name.startsWith("sqlite_autoindex_")
      ? generatedLegacyIndexName(db, definition.terms)
      : indexNameInUse(db, definition.name)
        ? generatedSavedViewsIndexName(db, definition.name)
        : definition.name;
    if (indexNameInUse(db, indexName)) {
      throw new Error(`Cannot restore saved_views index ${definition.name} safely`);
    }
    const terms = definition.terms
      .map((term) => {
        const column = quoteIdentifier(term.name ?? "");
        const collation = quoteIdentifier(term.coll);
        return `${column} COLLATE ${collation}${term.desc === 1 ? " DESC" : ""}`;
      })
      .join(", ");
    db.exec(
      `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(indexName)} ON saved_views(${terms})`,
    );
  }
}

function isSavedViewsForeignKeyRow(value: unknown): value is SavedViewsForeignKeyRow {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("id" in value) ||
    !("seq" in value) ||
    !("table" in value) ||
    !("from" in value) ||
    !("to" in value) ||
    !("on_update" in value) ||
    !("on_delete" in value) ||
    !("match" in value)
  ) {
    return false;
  }
  return (
    typeof value.id === "number" &&
    typeof value.seq === "number" &&
    typeof value.table === "string" &&
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    typeof value.on_update === "string" &&
    typeof value.on_delete === "string" &&
    typeof value.match === "string"
  );
}

function foreignKeyGroups(db: Database, table: string): SavedViewsForeignKeyRow[][] {
  const groups = new Map<number, SavedViewsForeignKeyRow[]>();
  for (const value of db.query("SELECT * FROM pragma_foreign_key_list(?1)").all(table)) {
    if (!isSavedViewsForeignKeyRow(value)) return [];
    const group = groups.get(value.id);
    if (group) {
      group.push(value);
    } else {
      groups.set(value.id, [value]);
    }
  }
  return [...groups.values()].map((group) =>
    [...group].sort((left, right) => left.seq - right.seq),
  );
}

function savedViewsForeignKeyGroups(db: Database): SavedViewsForeignKeyRow[][] {
  return foreignKeyGroups(db, "saved_views");
}

function matchesSavedViewsForeignKey(
  rows: readonly SavedViewsForeignKeyRow[],
  expected: SavedViewsForeignKeyDefinition,
): boolean {
  if (rows.length !== expected.columns.length) return false;
  return rows.every((row, position) => {
    const expectedColumn = expected.columns[position];
    return (
      expectedColumn !== undefined &&
      row.seq === position &&
      row.table === expected.table &&
      row.from === expectedColumn.from &&
      row.to === expectedColumn.to &&
      row.on_update === expected.onUpdate &&
      row.on_delete === expected.onDelete &&
      (expected.match === undefined || row.match === expected.match)
    );
  });
}

function describeSavedViewsForeignKey(rows: readonly SavedViewsForeignKeyRow[]): string {
  const first = rows[0];
  const table = first?.table ?? "unknown";
  return (
    `(${rows.map((row) => row.from).join(", ")}) -> ` +
    `${table}(${rows.map((row) => row.to).join(", ")})`
  );
}

function hasSavedViewsForeignKey(
  db: Database,
  foreignKey: SavedViewsForeignKeyDefinition,
  groups = savedViewsForeignKeyGroups(db),
): boolean {
  const matchingGroups = groups.filter((rows) => matchesSavedViewsForeignKey(rows, foreignKey));
  return matchingGroups.length === 1;
}

function normalizedContractValue(value: string | null): string | null {
  return value === null ? null : normalizedSql(value);
}

function tableSql(db: Database, table: string): string | null {
  return (
    db
      .query<SqlDefinitionRow, SQLQueryBindings[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
      )
      .get(table)?.sql ?? null
  );
}

function columnContractProblems(
  db: Database,
  table: string,
  expected: readonly ColumnContract[],
): string[] {
  if (!hasTable(db, table)) return [`missing table ${table}`];
  const actual = tableInfo(db, table);
  const problems: string[] = [];
  if (actual.length !== expected.length) {
    const expectedNames = new Set(expected.map((column) => column.name));
    const unexpected = actual
      .filter((column) => !expectedNames.has(column.name))
      .map((column) => column.name);
    if (unexpected.length > 0)
      problems.push(`${table} has unexpected columns: ${unexpected.join(", ")}`);
    if (actual.length < expected.length) {
      const actualNames = new Set(actual.map((column) => column.name));
      const missing = expected
        .filter((column) => !actualNames.has(column.name))
        .map((column) => column.name);
      if (missing.length > 0) problems.push(`${table} missing columns: ${missing.join(", ")}`);
    }
  }
  for (const [position, contract] of expected.entries()) {
    const column = actual[position];
    if (!column) {
      if (actual.length >= expected.length) {
        problems.push(`${table}.${contract.name} is missing from its canonical position`);
      }
      continue;
    }
    if (column.name !== contract.name) {
      problems.push(`${table}.${contract.name} has an incompatible column order`);
      continue;
    }
    if (column.type.trim().toUpperCase() !== contract.type) {
      problems.push(`${table}.${contract.name} has type ${column.type}, expected ${contract.type}`);
    }
    if (column.notnull !== contract.notNull) {
      problems.push(
        `${table}.${contract.name} has NOT NULL=${column.notnull}, expected ${contract.notNull}`,
      );
    }
    if (
      normalizedContractValue(column.dflt_value) !== normalizedContractValue(contract.defaultValue)
    ) {
      problems.push(
        `${table}.${contract.name} has default ${column.dflt_value ?? "NULL"}, expected ${contract.defaultValue ?? "NULL"}`,
      );
    }
    if (column.pk !== contract.primaryKey) {
      problems.push(
        `${table}.${contract.name} has primary-key position ${column.pk}, expected ${contract.primaryKey}`,
      );
    }
  }
  return problems;
}

function checkConstraintProblems(db: Database, table: string, checks: readonly string[]): string[] {
  const definition = tableSql(db, table);
  if (definition === null) return [`missing table ${table}`];
  const actualChecks = checkExpressionsFromDefinition(definition);
  const executable = executableTableDefinition(db, definition);
  if (actualChecks === null || !executable) {
    return [
      `${table} has an invalid or unparsable SQL definition`,
      ...checks.map((expression) => `${table} is missing CHECK (${expression})`),
    ];
  }
  const actual = actualChecks.map(comparableSqlTokens);
  return checks
    .filter((expression) => {
      const expectedTokens = sqliteTokens(expression);
      if (expectedTokens === null) return true;
      const expected = comparableSqlTokens(expectedTokens);
      return !actual.some(
        (candidate) =>
          candidate.length === expected.length &&
          candidate.every((token, position) => token === expected[position]),
      );
    })
    .map((expression) => `${table} is missing CHECK (${expression})`);
}

function canonicalTableProblems(
  db: Database,
  table: string,
  columns: readonly ColumnContract[],
  checks: readonly string[],
): string[] {
  return [
    ...columnContractProblems(db, table, columns),
    ...checkConstraintProblems(db, table, checks),
  ];
}

function invalidSavedViewRows(db: Database): string[] {
  const checks = [
    {
      description: "required columns contain NULL",
      query: `SELECT 1 FROM saved_views
              WHERE id IS NULL OR name IS NULL OR scope IS NULL OR owner_id IS NULL
                 OR filter_json IS NULL OR order_by IS NULL OR group_by IS NULL
                 OR created_at IS NULL OR updated_at IS NULL OR columns_json IS NULL
              LIMIT 1`,
    },
    {
      description: "id values are not unique",
      query: "SELECT 1 FROM saved_views GROUP BY id HAVING count(*) > 1 LIMIT 1",
    },
    {
      description: "scope and team_id are inconsistent",
      query: `SELECT 1 FROM saved_views
              WHERE scope NOT IN ('personal', 'team', 'workspace')
                 OR (scope = 'team' AND team_id IS NULL)
                 OR (scope IN ('personal', 'workspace') AND team_id IS NOT NULL)
              LIMIT 1`,
    },
    {
      description: "owner_id references a missing Actor",
      query: `SELECT 1 FROM saved_views
              WHERE NOT EXISTS (SELECT 1 FROM actors WHERE actors.id = saved_views.owner_id)
              LIMIT 1`,
    },
    {
      description: "workspace_id references a missing Workspace",
      query: `SELECT 1 FROM saved_views
              WHERE workspace_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM workspace WHERE workspace.id = saved_views.workspace_id
                )
              LIMIT 1`,
    },
    {
      description: "workspace context is missing in a multi-Workspace database",
      query: `SELECT 1 FROM saved_views
              WHERE workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
              LIMIT 1`,
    },
    {
      description: "team_id crosses the saved view Workspace",
      query: `SELECT 1 FROM saved_views
              WHERE team_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM teams
                  WHERE teams.id = saved_views.team_id
                    AND teams.workspace_id IS saved_views.workspace_id
                )
              LIMIT 1`,
    },
  ];
  return checks
    .filter((check) => Boolean(db.query(check.query).get()))
    .map((check) => check.description);
}

function validateViewsMigrationPrerequisites(db: Database): void {
  if (!hasTable(db, "saved_views")) {
    throw new Error(
      "Cannot apply migration 0033 (views_preferences): saved_views is missing. " +
        "Restore a compatible saved_views schema or rebuild the database, then retry.",
    );
  }

  const missingColumns = SAVED_VIEWS_MIGRATION_COLUMNS.filter(
    (column) => !hasColumn(db, "saved_views", column),
  );
  if (missingColumns.length > 0) {
    throw new Error(
      `Cannot apply migration 0033 (views_preferences): saved_views has an incompatible schema ` +
        `(missing columns: ${missingColumns.join(", ")}). Restore a compatible saved_views ` +
        "schema or rebuild the database, then retry.",
    );
  }

  const missingTables = VIEWS_MIGRATION_REQUIRED_TABLES.filter((table) => !hasTable(db, table));
  if (missingTables.length > 0) {
    throw new Error(
      `Cannot apply migration 0033 (views_preferences): required tables are missing ` +
        `(${missingTables.join(", ")}). Restore a compatible saved_views schema and data ` +
        "or rebuild the database, then retry.",
    );
  }

  const schemaProblems = canonicalTableProblems(
    db,
    "saved_views",
    LEGACY_SAVED_VIEWS_COLUMN_CONTRACT,
    LEGACY_SAVED_VIEWS_CHECKS,
  );
  const foreignKeySchemaProblems = foreignKeyProblems(
    db,
    "saved_views",
    SAVED_VIEWS_REQUIRED_FOREIGN_KEYS,
  );
  const missingIndexes = VIEWS_MIGRATION_REQUIRED_INDEXES.filter(
    (index) => !hasIndexWithColumns(db, index.table, index.columns, index.unique),
  );
  const invalidRows = invalidSavedViewRows(db);
  const indexProblems = savedViewsIndexProblems(savedViewsIndexDefinitions(db));
  const problems = [
    ...schemaProblems,
    ...foreignKeySchemaProblems,
    ...(missingIndexes.length > 0
      ? [
          `missing indexes: ${missingIndexes
            .map(
              (index) =>
                `${index.unique ? "UNIQUE " : ""}${index.table}(${index.columns.join(", ")})`,
            )
            .join(", ")}`,
        ]
      : []),
    ...(invalidRows.length > 0 ? [`invalid rows: ${invalidRows.join(", ")}`] : []),
    ...indexProblems,
  ];
  if (problems.length > 0) {
    throw new Error(
      `Cannot apply migration 0033 (views_preferences): saved_views has an incompatible ` +
        `schema or data (${problems.join("; ")}). Restore a compatible saved_views schema ` +
        "and data or rebuild the database, then retry.",
    );
  }
}

function foreignKeyProblems(
  db: Database,
  table: string,
  expected: readonly SavedViewsForeignKeyDefinition[],
): string[] {
  const groups =
    table === "saved_views" ? savedViewsForeignKeyGroups(db) : foreignKeyGroups(db, table);
  const missing = expected.filter((foreignKey) => !hasSavedViewsForeignKey(db, foreignKey, groups));
  const unexpected = groups.filter(
    (rows) => !expected.some((foreignKey) => matchesSavedViewsForeignKey(rows, foreignKey)),
  );
  return [
    ...(missing.length > 0
      ? [
          `${table} missing foreign keys: ${missing
            .map(
              (foreignKey) =>
                `(${foreignKey.columns.map((column) => column.from).join(", ")}) -> ` +
                `${foreignKey.table}(${foreignKey.columns.map((column) => column.to).join(", ")})`,
            )
            .join(", ")}`,
        ]
      : []),
    ...(unexpected.length > 0
      ? [
          `${table} has unexpected foreign keys: ${unexpected
            .map((rows) => describeSavedViewsForeignKey(rows))
            .join(", ")}`,
        ]
      : []),
  ];
}

function triggerProblems(db: Database, expected: Readonly<Record<string, string>>): string[] {
  return Object.entries(expected).flatMap(([name, fragment]) => {
    const definition = db
      .query<SqlDefinitionRow, SQLQueryBindings[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
      )
      .get(name);
    if (!definition?.sql || !normalizedSql(definition.sql).includes(normalizedSql(fragment))) {
      return [`missing or incompatible trigger ${name}`];
    }
    return [];
  });
}

function viewsMigrationSchemaProblems(db: Database, requireWorkspaceIndex: boolean): string[] {
  const problems: string[] = [];
  if (hasTable(db, "_prb390_saved_views")) {
    problems.push("stale table _prb390_saved_views");
  }
  const targetTables = [
    ["saved_views", SAVED_VIEWS_TARGET_COLUMN_CONTRACT, VIEWS_MIGRATION_CHECKS.saved_views],
    ["view_preferences", VIEW_PREFERENCES_COLUMN_CONTRACT, VIEWS_MIGRATION_CHECKS.view_preferences],
    [
      "view_subscriptions",
      VIEW_SUBSCRIPTIONS_COLUMN_CONTRACT,
      VIEWS_MIGRATION_CHECKS.view_subscriptions,
    ],
  ] as const;

  for (const [table, columns, checks] of targetTables) {
    if (!hasTable(db, table)) {
      problems.push(`missing table ${table}`);
      continue;
    }
    problems.push(...canonicalTableProblems(db, table, columns, checks));
  }
  for (const table of VIEWS_MIGRATION_REQUIRED_TABLES) {
    if (!hasTable(db, table)) problems.push(`missing table ${table}`);
  }

  const savedViewsIndexes = [
    ["idx_saved_views_scope", ["scope", "team_id"], false],
    ["idx_saved_views_owner", ["owner_id"], false],
    ["idx_saved_views_project", ["workspace_id", "project_id"], false],
    ["idx_saved_views_initiative", ["workspace_id", "initiative_id"], false],
  ] as const;
  for (const [name, columns, unique] of savedViewsIndexes) {
    if (!hasNamedIndexWithColumns(db, "saved_views", name, columns, unique)) {
      problems.push(`missing or incompatible index ${name}`);
    }
  }
  if (
    !hasUniqueConstraintWithColumns(
      db,
      "saved_views",
      VIEWS_MIGRATION_UNIQUE_CONSTRAINTS.saved_views,
    )
  ) {
    problems.push("missing or incompatible UNIQUE constraint saved_views(workspace_id, id)");
  }
  const hasWorkspaceIndex = hasNamedIndexWithColumns(
    db,
    "saved_views",
    "idx_saved_views_workspace_id",
    ["workspace_id", "id"],
    true,
  );
  if (requireWorkspaceIndex && !hasWorkspaceIndex) {
    problems.push("missing or incompatible index idx_saved_views_workspace_id");
  } else if (
    hasNamedIndex(db, "saved_views", "idx_saved_views_workspace_id") &&
    !hasWorkspaceIndex
  ) {
    problems.push("incompatible index idx_saved_views_workspace_id");
  }
  problems.push(...foreignKeyProblems(db, "saved_views", SAVED_VIEWS_TARGET_FOREIGN_KEYS));

  const viewPreferencesIndexes = [
    ["idx_view_preferences_view", ["workspace_id", "view_id"]],
    ["idx_view_preferences_actor", ["workspace_id", "actor_id"]],
  ] as const;
  for (const [name, columns] of viewPreferencesIndexes) {
    if (!hasNamedIndexWithColumns(db, "view_preferences", name, columns, false)) {
      problems.push(`missing or incompatible index ${name}`);
    }
  }
  if (!hasViewPreferencesKeyIndex(db)) {
    problems.push("missing or incompatible index idx_view_preferences_key");
  }
  if (
    !hasUniqueConstraintWithColumns(
      db,
      "view_preferences",
      VIEWS_MIGRATION_UNIQUE_CONSTRAINTS.view_preferences,
    )
  ) {
    problems.push("missing or incompatible UNIQUE constraint view_preferences(workspace_id, id)");
  }
  problems.push(
    ...foreignKeyProblems(db, "view_preferences", VIEW_PREFERENCES_REQUIRED_FOREIGN_KEYS),
  );

  const viewSubscriptionsIndexes = [
    ["idx_view_subscriptions_view", ["workspace_id", "view_id"]],
    ["idx_view_subscriptions_actor", ["workspace_id", "actor_id"]],
  ] as const;
  for (const [name, columns] of viewSubscriptionsIndexes) {
    if (!hasNamedIndexWithColumns(db, "view_subscriptions", name, columns, false)) {
      problems.push(`missing or incompatible index ${name}`);
    }
  }
  if (
    !hasUniqueConstraintWithColumns(
      db,
      "view_subscriptions",
      VIEWS_MIGRATION_UNIQUE_CONSTRAINTS.view_subscriptions,
    )
  ) {
    problems.push(
      "missing or incompatible UNIQUE constraint view_subscriptions(workspace_id, view_id, actor_id)",
    );
  }
  problems.push(
    ...foreignKeyProblems(db, "view_subscriptions", VIEW_SUBSCRIPTIONS_REQUIRED_FOREIGN_KEYS),
  );

  for (const index of VIEWS_MIGRATION_REQUIRED_INDEXES) {
    if (index.table === "saved_views") continue;
    if (!hasIndexWithColumns(db, index.table, index.columns, index.unique)) {
      problems.push(
        `missing or incompatible index ${index.unique ? "UNIQUE " : ""}${index.table}(${index.columns.join(", ")})`,
      );
    }
  }
  problems.push(
    ...triggerProblems(db, {
      saved_views_workspace_scope_insert:
        "AFTER INSERT ON saved_views WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id; END",
      saved_views_workspace_required_insert:
        "BEFORE INSERT ON saved_views WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN SELECT RAISE(ABORT, 'Workspace context is required for saved_views'); END",
      saved_views_workspace_required_update:
        "BEFORE UPDATE OF workspace_id ON saved_views WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN SELECT RAISE(ABORT, 'Workspace context is required for saved_views'); END",
    }),
  );

  return problems;
}

function hasAllColumns(db: Database, table: string, columns: readonly string[]): boolean {
  if (!hasTable(db, table)) return false;
  const actual = new Set(tableInfo(db, table).map((column) => column.name));
  return columns.every((column) => actual.has(column));
}

function hasRows(db: Database, query: string): boolean {
  return Boolean(db.query(query).get());
}

function viewsMigrationDataProblems(db: Database): string[] {
  const problems: string[] = [];
  if (
    VIEWS_MIGRATION_REQUIRED_TABLES.every((table) => hasTable(db, table)) &&
    hasAllColumns(db, "saved_views", [
      "id",
      "name",
      "scope",
      "team_id",
      "project_id",
      "initiative_id",
      "owner_id",
      "filter_json",
      "order_by",
      "group_by",
      "created_at",
      "updated_at",
      "columns_json",
      "workspace_id",
    ])
  ) {
    const savedViewsChecks = [
      [
        "saved_views has NULL in a required column",
        `SELECT 1 FROM saved_views
         WHERE id IS NULL OR name IS NULL OR scope IS NULL OR owner_id IS NULL
            OR filter_json IS NULL OR order_by IS NULL OR group_by IS NULL
            OR created_at IS NULL OR updated_at IS NULL OR columns_json IS NULL
         LIMIT 1`,
      ],
      [
        "saved_views has duplicate ids",
        "SELECT 1 FROM saved_views GROUP BY id HAVING count(*) > 1 LIMIT 1",
      ],
      [
        "saved_views has an invalid scope relationship",
        `SELECT 1 FROM saved_views
         WHERE scope NOT IN ('personal', 'team', 'workspace', 'project', 'initiative')
            OR (scope = 'team' AND (team_id IS NULL OR project_id IS NOT NULL OR initiative_id IS NOT NULL))
            OR (scope = 'project' AND (project_id IS NULL OR team_id IS NOT NULL OR initiative_id IS NOT NULL))
            OR (scope = 'initiative' AND (initiative_id IS NULL OR team_id IS NOT NULL OR project_id IS NOT NULL))
            OR (scope IN ('personal', 'workspace') AND (team_id IS NOT NULL OR project_id IS NOT NULL OR initiative_id IS NOT NULL))
         LIMIT 1`,
      ],
      [
        "saved_views references a missing Workspace",
        `SELECT 1 FROM saved_views
         WHERE workspace_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id = saved_views.workspace_id)
         LIMIT 1`,
      ],
      [
        "saved_views has no Workspace context in a multi-Workspace database",
        `SELECT 1 FROM saved_views
         WHERE workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
         LIMIT 1`,
      ],
      [
        "saved_views references a missing Actor",
        `SELECT 1 FROM saved_views
         WHERE NOT EXISTS (SELECT 1 FROM actors WHERE actors.id = saved_views.owner_id)
         LIMIT 1`,
      ],
      [
        "saved_views team reference is missing or crosses its Workspace",
        `SELECT 1 FROM saved_views
         WHERE team_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM teams
              WHERE teams.id = saved_views.team_id
                AND teams.workspace_id IS saved_views.workspace_id
           )
         LIMIT 1`,
      ],
      [
        "saved_views project reference is missing or crosses its Workspace",
        `SELECT 1 FROM saved_views
         WHERE project_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM projects
              WHERE projects.id = saved_views.project_id
                AND projects.workspace_id IS saved_views.workspace_id
           )
         LIMIT 1`,
      ],
      [
        "saved_views initiative reference is missing or crosses its Workspace",
        `SELECT 1 FROM saved_views
         WHERE initiative_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM initiatives
              WHERE initiatives.id = saved_views.initiative_id
                AND initiatives.workspace_id IS saved_views.workspace_id
           )
         LIMIT 1`,
      ],
    ] as const;
    for (const [description, query] of savedViewsChecks) {
      if (hasRows(db, query)) problems.push(description);
    }
  }

  if (
    ["workspace", "saved_views", "workspace_memberships"].every((table) => hasTable(db, table)) &&
    hasAllColumns(db, "view_preferences", [
      "id",
      "workspace_id",
      "view_id",
      "actor_id",
      "view_type",
      "scope",
      "layout",
      "order_by",
      "group_by",
      "columns_json",
      "created_at",
      "updated_at",
    ])
  ) {
    const preferenceChecks = [
      [
        "view_preferences has NULL in a required column",
        `SELECT 1 FROM view_preferences
         WHERE id IS NULL OR workspace_id IS NULL OR view_type IS NULL OR scope IS NULL
            OR layout IS NULL OR order_by IS NULL OR group_by IS NULL
            OR columns_json IS NULL OR created_at IS NULL OR updated_at IS NULL
         LIMIT 1`,
      ],
      [
        "view_preferences has an invalid enum value",
        `SELECT 1 FROM view_preferences
         WHERE view_type NOT IN ('issue', 'project', 'initiative', 'feed')
            OR scope NOT IN ('actor', 'workspace')
            OR layout NOT IN ('list', 'board')
            OR order_by NOT IN ('CREATED_ASC', 'CREATED_DESC', 'UPDATED_ASC', 'UPDATED_DESC')
            OR group_by NOT IN ('state', 'milestone', 'assignee', 'priority')
         LIMIT 1`,
      ],
      [
        "view_preferences has an invalid actor scope",
        `SELECT 1 FROM view_preferences
         WHERE (scope = 'actor' AND actor_id IS NULL)
            OR (scope = 'workspace' AND actor_id IS NOT NULL)
         LIMIT 1`,
      ],
      [
        "view_preferences references a missing Workspace",
        `SELECT 1 FROM view_preferences
         WHERE NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id = view_preferences.workspace_id)
         LIMIT 1`,
      ],
      [
        "view_preferences references a missing or cross-Workspace SavedView",
        `SELECT 1 FROM view_preferences
         WHERE view_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM saved_views
              WHERE saved_views.id = view_preferences.view_id
                AND saved_views.workspace_id IS view_preferences.workspace_id
           )
         LIMIT 1`,
      ],
      [
        "view_preferences actor is missing or outside its Workspace",
        `SELECT 1 FROM view_preferences
         WHERE actor_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM workspace_memberships
              WHERE workspace_memberships.workspace_id = view_preferences.workspace_id
                AND workspace_memberships.actor_id = view_preferences.actor_id
           )
         LIMIT 1`,
      ],
      [
        "view_preferences has duplicate keys",
        `SELECT 1 FROM view_preferences
         GROUP BY workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, '')
         HAVING count(*) > 1 LIMIT 1`,
      ],
    ] as const;
    for (const [description, query] of preferenceChecks) {
      if (hasRows(db, query)) problems.push(description);
    }
  }

  if (
    ["saved_views", "workspace_memberships", "workspace"].every((table) => hasTable(db, table)) &&
    hasAllColumns(db, "view_subscriptions", [
      "id",
      "workspace_id",
      "view_id",
      "actor_id",
      "issue_changes",
      "slack",
      "created_at",
      "updated_at",
    ])
  ) {
    const subscriptionChecks = [
      [
        "view_subscriptions has NULL in a required column",
        `SELECT 1 FROM view_subscriptions
         WHERE id IS NULL OR workspace_id IS NULL OR view_id IS NULL OR actor_id IS NULL
            OR issue_changes IS NULL OR slack IS NULL OR created_at IS NULL OR updated_at IS NULL
         LIMIT 1`,
      ],
      [
        "view_subscriptions has invalid channel values",
        `SELECT 1 FROM view_subscriptions
         WHERE typeof(issue_changes) <> 'integer' OR issue_changes NOT IN (0, 1)
            OR typeof(slack) <> 'integer' OR slack NOT IN (0, 1)
            OR (issue_changes = 0 AND slack = 0)
         LIMIT 1`,
      ],
      [
        "view_subscriptions references a missing Workspace",
        `SELECT 1 FROM view_subscriptions
         WHERE NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id = view_subscriptions.workspace_id)
         LIMIT 1`,
      ],
      [
        "view_subscriptions references a missing or cross-Workspace SavedView",
        `SELECT 1 FROM view_subscriptions
         WHERE NOT EXISTS (
             SELECT 1 FROM saved_views
              WHERE saved_views.id = view_subscriptions.view_id
                AND saved_views.workspace_id IS view_subscriptions.workspace_id
           )
         LIMIT 1`,
      ],
      [
        "view_subscriptions actor is missing or outside its Workspace",
        `SELECT 1 FROM view_subscriptions
         WHERE NOT EXISTS (
             SELECT 1 FROM workspace_memberships
              WHERE workspace_memberships.workspace_id = view_subscriptions.workspace_id
                AND workspace_memberships.actor_id = view_subscriptions.actor_id
           )
         LIMIT 1`,
      ],
      [
        "view_subscriptions has duplicate keys",
        `SELECT 1 FROM view_subscriptions
         GROUP BY workspace_id, view_id, actor_id HAVING count(*) > 1 LIMIT 1`,
      ],
    ] as const;
    for (const [description, query] of subscriptionChecks) {
      if (hasRows(db, query)) problems.push(description);
    }
  }

  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    problems.push("Views tables have foreign-key violations");
  }
  return problems;
}

function validateViewsMigrationSchema(db: Database, requireWorkspaceIndex: boolean): void {
  const problems = [
    ...viewsMigrationSchemaProblems(db, requireWorkspaceIndex),
    ...viewsMigrationDataProblems(db),
  ];
  if (problems.length > 0) {
    throw new Error(
      `Views migration schema or data is incomplete or incompatible (${problems.join("; ")})`,
    );
  }
}

function notificationPreferencesSchemaProblems(db: Database): string[] {
  const problems: string[] = [];
  if (!hasTable(db, "notification_preferences")) {
    return ["missing table notification_preferences"];
  }
  const missingColumns = NOTIFICATION_PREFERENCES_COLUMNS.filter(
    (column) => !hasColumn(db, "notification_preferences", column),
  );
  if (missingColumns.length > 0) {
    problems.push(`notification_preferences missing columns: ${missingColumns.join(", ")}`);
  }
  if (
    !hasPrimaryKeyColumns(db, "notification_preferences", [
      "workspace_id",
      "actor_id",
      "category",
      "channel",
    ])
  ) {
    problems.push("notification_preferences has an incompatible primary key");
  }
  if (
    !hasNamedIndexWithColumns(
      db,
      "notification_preferences",
      "idx_notification_preferences_actor_workspace",
      ["actor_id", "workspace_id"],
      false,
    )
  ) {
    problems.push("missing or incompatible index idx_notification_preferences_actor_workspace");
  }
  return problems;
}

function validateNotificationPreferencesSchema(db: Database): void {
  const problems = notificationPreferencesSchemaProblems(db);
  if (problems.length > 0) {
    throw new Error(
      `Notification migration schema is incomplete or incompatible (${problems.join("; ")})`,
    );
  }
}

function migrationMarker(db: Database, version: number): MigrationMarkerRow | null {
  return (
    db
      .query<MigrationMarkerRow, SQLQueryBindings[]>(
        "SELECT version, name, applied_at FROM _migrations WHERE version = ?1",
      )
      .get(version) ?? null
  );
}

function hasViewsMigrationArtifacts(db: Database): boolean {
  if (VIEWS_MIGRATION_ARTIFACT_TABLES.some((table) => hasTable(db, table))) return true;
  if (hasViewPreferencesKeyIndex(db)) return true;
  if (
    VIEWS_MIGRATION_ARTIFACT_INDEXES.some((artifact) =>
      hasNamedIndexWithColumns(
        db,
        artifact.table,
        artifact.name,
        artifact.columns,
        artifact.unique,
      ),
    )
  ) {
    return true;
  }
  return (
    hasTable(db, "saved_views") &&
    (hasColumn(db, "saved_views", "project_id") || hasColumn(db, "saved_views", "initiative_id"))
  );
}

function reconcileLegacyViewsMigration(db: Database, marker: MigrationMarkerRow): void {
  if (marker.name !== "views_preferences" || marker.version !== 32) {
    throw new Error("Cannot reconcile an unexpected Views migration marker");
  }
  try {
    validateViewsMigrationSchema(db, false);
  } catch (error) {
    throw new Error(
      `Cannot reconcile legacy Views migration: incomplete or incompatible schema or data. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  db.transaction(() => {
    const appliedAt = now();
    db.exec(migration0032);
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_views_workspace_id ON saved_views(workspace_id, id)",
    );
    db.query("UPDATE _migrations SET name = ?1, applied_at = ?2 WHERE version = 32").run(
      "notification_preferences",
      appliedAt,
    );
    db.query("INSERT INTO _migrations (version, name, applied_at) VALUES (33, ?1, ?2)").run(
      "views_preferences",
      appliedAt,
    );
    validateNotificationPreferencesSchema(db);
    validateViewsMigrationSchema(db, true);
    validateWorkspaceConstraints(db);
  })();
}

function validateMigrationMarkersAndReconcile(db: Database): void {
  const marker32 = migrationMarker(db, 32);
  const marker33 = migrationMarker(db, 33);
  const hasNotificationTable = hasTable(db, "notification_preferences");
  const hasViewsArtifacts = hasViewsMigrationArtifacts(db);

  if (marker32 && !["notification_preferences", "views_preferences"].includes(marker32.name)) {
    throw new Error(
      `Cannot reconcile migration 0032 marker: name ${marker32.name} is contradictory or unknown`,
    );
  }
  if (marker33 && marker33.name !== "views_preferences") {
    throw new Error(
      `Cannot reconcile migration 0033 marker: name ${marker33.name} is contradictory or unknown`,
    );
  }

  if (marker32?.name === "views_preferences") {
    if (marker33) {
      throw new Error("Cannot reconcile migration 0032 marker: Views is already marked as 0033");
    }
    if (hasNotificationTable) {
      throw new Error(
        "Cannot reconcile migration 0032 marker: Views marker contradicts notification_preferences",
      );
    }
    reconcileLegacyViewsMigration(db, marker32);
    return;
  }

  if (marker32?.name === "notification_preferences") {
    if (!hasNotificationTable && hasViewsArtifacts) {
      throw new Error(
        "Cannot reconcile migration 0032 marker: notification name contradicts the legacy Views schema",
      );
    }
    try {
      validateNotificationPreferencesSchema(db);
    } catch (error) {
      throw new Error(
        `Cannot apply migration 0032: marker is present but the schema is incomplete or incompatible. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (marker33) {
      if (hasViewsArtifacts) {
        try {
          validateViewsMigrationSchema(db, true);
        } catch (error) {
          throw new Error(
            `Cannot apply migration 0033: marker is present but the schema is incomplete or incompatible. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        throw new Error(
          "Cannot apply migration 0033: marker is present but Views schema is missing",
        );
      }
    } else if (hasViewsArtifacts) {
      throw new Error(
        "Cannot apply migration 0033: Views schema is partially applied or its marker is missing",
      );
    }
    return;
  }

  if (marker33) {
    throw new Error("Cannot apply migration 0033: marker is present without migration 0032");
  }
  if (hasNotificationTable) {
    throw new Error(
      "Cannot apply migration 0032: notification_preferences exists without its migration marker",
    );
  }
  if (hasViewsArtifacts) {
    throw new Error(
      "Cannot apply migration 0033: Views schema is partially applied or its marker is missing",
    );
  }
}

function validateViewsMigrationResult(db: Database): void {
  try {
    validateViewsMigrationSchema(db, true);
    validateWorkspaceConstraints(db);
  } catch (error) {
    throw new Error(
      "Cannot apply migration 0033 (views_preferences): rebuilt schema or data is incompatible. " +
        `${error instanceof Error ? error.message : String(error)} Restore a compatible ` +
        "saved_views schema and data or rebuild the database, then retry.",
    );
  }
}

export function migrate(db: Database, options: MigrationOptions = {}): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  validateMigrationMarkersAndReconcile(db);
  const applied = new Set(
    db
      .query("SELECT version FROM _migrations")
      .values()
      .map((row) => row[0] as number),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    // PRB-390 reconstruye SavedViews y no puede continuar sin su esquema legacy.
    // El preflight ocurre antes de desactivar las FKs o abrir la transacción para
    // que una base incompatible falle sin escrituras parciales y pueda repararse.
    if (migration.version === 33) validateViewsMigrationPrerequisites(db);
    // PRB-472 y PRB-390 reconstruyen el grafo de tablas para reemplazar FKs
    // simples por FKs compuestas. SQLite no permite cambiar foreign_keys dentro
    // de una transacción activa. El runner desactiva las comprobaciones solo
    // alrededor de estas migraciones y las reactiva aun si una falla.
    const rebuild = migration.version === 25 || migration.version === 33;
    const savedViewIndexes = migration.version === 33 ? savedViewsIndexDefinitions(db) : [];
    if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        if (migration.version === 24) validateWorkspaceMigration(db, "before");
        if (migration.version === 26) validateApiKeyWorkspaceMigration(db, "before");
        if (migration.version === 30) verifyDocumentsBeforeRetirement(db, options);
        db.exec(migration.sql);
        if (migration.version === 33) restoreSavedViewsIndexes(db, savedViewIndexes);
        if (migration.version === 24) {
          normalizeBackfilledMembershipIds(db);
          validateWorkspaceMigration(db, "after");
        }
        if (migration.version === 25) validateWorkspaceConstraints(db);
        // 0033 valida el esquema reconstruido antes de registrar su marker, dentro
        // de la misma transacción que copió los datos y cambió las tablas.
        if (migration.version === 33) validateViewsMigrationResult(db);
        if (migration.version === 26) validateApiKeyWorkspaceMigration(db, "after");
        db.query("INSERT INTO _migrations (version, name, applied_at) VALUES (?1, ?2, ?3)").run(
          migration.version,
          migration.name,
          now(),
        );
      })();
    } finally {
      if (rebuild) db.exec("PRAGMA foreign_keys = ON");
    }
    if (rebuild) {
      validateWorkspaceConstraints(db);
    }
  }

  // Las bases existentes no pasan por bootstrap otra vez. Conservamos su
  // comportamiento anterior haciendo miembros owner a los actores ya creados.
  const membershipCount = db.query("SELECT count(*) AS count FROM team_memberships").get() as {
    count: number;
  };
  if (membershipCount.count === 0) {
    // El backfill histórico asignaba cada Actor a cada Team. Después de la
    // migración multi-Workspace, solo son válidas las combinaciones cubiertas
    // por una Membership del mismo Workspace.
    const candidates = db
      .query(
        `SELECT teams.id AS team_id, actors.id AS actor_id, teams.workspace_id
         FROM teams
         JOIN workspace_memberships
           ON workspace_memberships.workspace_id = teams.workspace_id
         JOIN actors ON actors.id = workspace_memberships.actor_id
         WHERE teams.workspace_id IS NOT NULL
         ORDER BY teams.id, actors.id`,
      )
      .all() as Array<{ team_id: string; actor_id: string; workspace_id: string }>;
    const insert = db.query(
      "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at, workspace_id) VALUES (?1, ?2, ?3, 'owner', ?4, ?5)",
    );
    if (candidates.length > 0) {
      db.transaction(() => {
        const timestamp = now();
        for (const candidate of candidates) {
          insert.run(
            newId(),
            candidate.team_id,
            candidate.actor_id,
            timestamp,
            candidate.workspace_id,
          );
        }
      })();
    }
  }
}
