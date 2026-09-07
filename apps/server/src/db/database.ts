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

// 0025 reconstruye estas tablas no-Views con DROP TABLE/ALTER TABLE RENAME.
// Mantener la lista explícita evita que una tabla nueva quede fuera del preflight.
// saved_views queda fuera: PRB-654 conserva su contrato en su propio helper.
const WORKSPACE_CONSTRAINTS_REBUILT_TABLES = [
  "teams",
  "workflow_states",
  "projects",
  "milestones",
  "issues",
  "labels",
  "cycles",
  "project_teams",
  "issue_labels",
  "issue_relations",
  "comments",
  "activity",
  "webhooks",
  "reviews",
  "initiatives",
  "initiative_projects",
  "initiative_teams",
  "project_updates",
  "team_memberships",
  "api_key_team_limits",
  "inbox_receipts",
  "favorites",
  "actor_invitations",
] satisfies readonly string[];

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

interface TriggerDefinitionRow {
  name: string | null;
  tbl_name: string | null;
  sql: string | null;
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

type RecreatedSchemaObjectType = "view" | "trigger";
type RecreatedSchemaObject = SchemaObjectRow & { type: RecreatedSchemaObjectType };

function isRecreatedSchemaObject(object: SchemaObjectRow): object is RecreatedSchemaObject {
  return object.type === "view" || object.type === "trigger";
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

/**
 * SQLite aplica NOCASE solo a caracteres ASCII al resolver identificadores.
 * Esta normalización conserva la misma regla para los valores que devuelve PRAGMA.
 */
function normalizeSqliteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20),
  );
}

function sameSqliteIdentifier(left: string, right: string): boolean {
  return normalizeSqliteIdentifier(left) === normalizeSqliteIdentifier(right);
}

function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 COLLATE NOCASE")
      .get(table),
  );
}

function schemaObjects(db: Database, name: string): SchemaObjectRow[] {
  return db
    .query<SchemaObjectRow, SQLQueryBindings[]>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ?1 COLLATE NOCASE ORDER BY type, name",
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
  return tableInfo(db, table).some((value) => sameSqliteIdentifier(value.name, column));
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
        term.name !== null &&
        columns[position] !== undefined &&
        sameSqliteIdentifier(term.name, columns[position]) &&
        term.desc === 0 &&
        sameSqliteIdentifier(term.coll, "BINARY"),
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
  const index = indexList(db, table).find((value) => sameSqliteIdentifier(value.name, name));
  return Boolean(index && indexHasColumns(index, indexTerms(db, index.name), columns, unique));
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
      return (
        expected !== undefined &&
        column.pk === position + 1 &&
        sameSqliteIdentifier(column.name, expected)
      );
    })
  );
}

function hasNamedIndex(db: Database, table: string, name: string): boolean {
  return indexList(db, table).some((index) => sameSqliteIdentifier(index.name, name));
}

function hasTrigger(db: Database, name: string): boolean {
  return Boolean(
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?1 COLLATE NOCASE LIMIT 1",
      )
      .get(name),
  );
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

const INDEXED_BY_SOURCE_BOUNDARIES = new Set([
  "on",
  "using",
  "where",
  "group",
  "order",
  "limit",
  "offset",
  "having",
  "union",
  "except",
  "intersect",
  "window",
  "returning",
  "set",
  "values",
]);
const INDEXED_BY_UPDATE_MODIFIERS = new Set(["rollback", "abort", "replace", "fail", "ignore"]);

interface SqlParenthesisPairs {
  matchingClose: ReadonlyMap<number, number>;
  enclosingOpen: readonly (number | undefined)[];
}

interface IndexedByCteScope {
  start: number;
  end: number;
  names: ReadonlySet<string>;
  namePositions: ReadonlySet<number>;
}

function sqlParenthesisPairs(tokens: readonly SqlToken[]): SqlParenthesisPairs | null {
  const openings: number[] = [];
  const matchingClose = new Map<number, number>();
  const enclosingOpen: Array<number | undefined> = [];
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    enclosingOpen[position] = openings[openings.length - 1];
    if (token?.value === "(") {
      openings.push(position);
    } else if (token?.value === ")") {
      const opening = openings.pop();
      if (opening === undefined) return null;
      matchingClose.set(opening, position);
    }
  }
  return openings.length === 0 ? { matchingClose, enclosingOpen } : null;
}

function indexedByWithTokenIsCteStart(tokens: readonly SqlToken[], position: number): boolean {
  const previous = tokens[position - 1];
  if (
    isSqlKeyword(previous, "view") ||
    isSqlKeyword(previous, "trigger") ||
    isSqlKeyword(previous, "exists")
  ) {
    return false;
  }

  let columnListDepth = 0;
  for (let cursor = position + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token?.value === "(") {
      columnListDepth += 1;
    } else if (token?.value === ")") {
      if (columnListDepth > 0) {
        columnListDepth -= 1;
      } else {
        if (isSqlKeyword(tokens[cursor + 1], "as")) return false;
        break;
      }
    }
  }

  let parentheses = 0;
  for (let cursor = position - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor];
    if (token?.value === ")") {
      parentheses += 1;
      continue;
    }
    if (token?.value === "(") {
      if (parentheses > 0) parentheses -= 1;
      continue;
    }
    if (parentheses > 0 || token === undefined || token.value === ".") continue;
    if (
      isSqlKeyword(token, "from") ||
      isSqlKeyword(token, "join") ||
      isSqlKeyword(token, "update") ||
      isSqlKeyword(token, "into")
    ) {
      return false;
    }
    if (
      token.value === ";" ||
      isSqlKeyword(token, "begin") ||
      isSqlKeyword(token, "create") ||
      isSqlKeyword(token, "view") ||
      isSqlKeyword(token, "trigger") ||
      isSqlKeyword(token, "union") ||
      isSqlKeyword(token, "except") ||
      isSqlKeyword(token, "intersect")
    ) {
      return true;
    }
    if (
      isSqlKeyword(token, "delete") ||
      isSqlKeyword(token, "group") ||
      isSqlKeyword(token, "having") ||
      isSqlKeyword(token, "insert") ||
      isSqlKeyword(token, "limit") ||
      isSqlKeyword(token, "on") ||
      isSqlKeyword(token, "order") ||
      isSqlKeyword(token, "returning") ||
      isSqlKeyword(token, "select") ||
      isSqlKeyword(token, "set") ||
      isSqlKeyword(token, "values") ||
      isSqlKeyword(token, "where") ||
      isSqlKeyword(token, "window")
    ) {
      return false;
    }
  }
  return true;
}

function indexedByCteScopeAt(
  tokens: readonly SqlToken[],
  parentheses: SqlParenthesisPairs,
  position: number,
): IndexedByCteScope | null {
  let cursor = position + 1;
  if (isSqlKeyword(tokens[cursor], "recursive")) cursor += 1;
  const names = new Set<string>();
  const namePositions = new Set<number>();
  while (true) {
    const namePosition = cursor;
    const name = tokens[namePosition];
    if (!isSqlNameToken(name)) return null;
    names.add(name.value.toLowerCase());
    namePositions.add(namePosition);
    cursor += 1;
    if (tokens[cursor]?.value === "(") {
      const columnsClose = parentheses.matchingClose.get(cursor);
      if (columnsClose === undefined) return null;
      cursor = columnsClose + 1;
    }
    if (!isSqlKeyword(tokens[cursor], "as")) return null;
    cursor += 1;
    if (isSqlKeyword(tokens[cursor], "not")) {
      if (!isSqlKeyword(tokens[cursor + 1], "materialized")) return null;
      cursor += 2;
    } else if (isSqlKeyword(tokens[cursor], "materialized")) {
      cursor += 1;
    }
    if (tokens[cursor]?.value !== "(") return null;
    const queryClose = parentheses.matchingClose.get(cursor);
    if (queryClose === undefined) return null;
    cursor = queryClose + 1;
    if (tokens[cursor]?.value !== ",") break;
    cursor += 1;
  }
  const enclosingOpen = parentheses.enclosingOpen[position];
  const enclosingClose =
    enclosingOpen === undefined ? undefined : parentheses.matchingClose.get(enclosingOpen);
  const semicolon = tokens.findIndex((token, index) => index > position && token.value === ";");
  const end =
    enclosingClose === undefined
      ? semicolon < 0
        ? tokens.length
        : semicolon
      : semicolon < 0 || semicolon > enclosingClose
        ? enclosingClose
        : semicolon;
  return { start: position, end, names, namePositions };
}

function indexedByCteScopes(
  tokens: readonly SqlToken[],
  parentheses: SqlParenthesisPairs,
): readonly IndexedByCteScope[] | null {
  const scopes: IndexedByCteScope[] = [];
  const cteNamePositions = new Set<number>();
  for (let position = 0; position < tokens.length; position += 1) {
    if (!isSqlKeyword(tokens[position], "with") || cteNamePositions.has(position)) continue;
    const scope = indexedByCteScopeAt(tokens, parentheses, position);
    if (scope !== null) {
      scopes.push(scope);
      for (const namePosition of scope.namePositions) cteNamePositions.add(namePosition);
    } else if (indexedByWithTokenIsCteStart(tokens, position)) {
      // Unparseable WITH clauses are unsafe. A bare WITH can also be a SQLite
      // identifier in a source or expression, so keep that valid form.
      return null;
    }
  }
  return scopes;
}

function indexedByReferenceUsesCte(
  scopes: readonly IndexedByCteScope[],
  position: number,
  tableName: string,
  tableSchema: string | undefined,
): boolean {
  if (tableSchema !== undefined) return false;
  const normalizedName = tableName.toLowerCase();
  return scopes.some(
    (scope) => position >= scope.start && position < scope.end && scope.names.has(normalizedName),
  );
}

type IndexedBySourceScope =
  | { phase: "none" }
  | {
      phase: "expect_update_table";
      tableSchema: string | undefined;
      inheritsSourceContext: boolean;
    }
  | {
      phase: "expect_update_modifier";
      tableSchema: string | undefined;
      inheritsSourceContext: boolean;
    }
  | { phase: "expect_table"; tableSchema: string | undefined; inheritsSourceContext: boolean }
  | {
      phase: "expect_alias";
      tableName: string;
      tableSchema: string | undefined;
      inheritsSourceContext: boolean;
    }
  | {
      phase: "after_table";
      tableName: string;
      tableSchema: string | undefined;
      inheritsSourceContext: boolean;
    };

type IndexedByReferenceSource = { kind: "table" } | { kind: "cte" };

interface IndexedByReference {
  token: SqlToken;
  indexName: string;
  tableName: string;
  tableSchema: string | undefined;
  source: IndexedByReferenceSource;
}

function inheritsIndexedBySourceContext(scope: IndexedBySourceScope): boolean {
  return scope.phase !== "none" && scope.inheritsSourceContext;
}

function expectIndexedByTable(
  scope: IndexedBySourceScope,
  tableSchema: string | undefined = undefined,
): IndexedBySourceScope {
  return {
    phase: "expect_table",
    tableSchema,
    inheritsSourceContext: inheritsIndexedBySourceContext(scope),
  };
}

/**
 * Extrae los nombres de índice que aparecen en cláusulas `INDEXED BY`. El
 * tokenizer descarta comentarios y conserva los literales como un solo token,
 * por lo que solo una secuencia SQL real puede producir una referencia.
 * `indexed` puede ser un nombre de tabla (por ejemplo, `FROM indexed by`), así
 * que la secuencia solo cuenta cuando ya se resolvió el nombre de una tabla
 * después de `FROM`, `JOIN` o `UPDATE`.
 */
function indexedByReferences(sql: string): readonly IndexedByReference[] | null {
  const tokens = sqliteTokens(sql);
  if (tokens === null) return null;
  const parentheses = sqlParenthesisPairs(tokens);
  if (parentheses === null) return null;
  const cteScopes = indexedByCteScopes(tokens, parentheses);
  if (cteScopes === null) return null;
  const references: IndexedByReference[] = [];
  const scopes: IndexedBySourceScope[] = [{ phase: "none" }];
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    const scopeIndex = scopes.length - 1;
    if (token?.value === "(") {
      const parent = scopes[scopeIndex];
      if (parent?.phase === "expect_table") {
        scopes.push({
          phase: "expect_table",
          tableSchema: parent.tableSchema,
          inheritsSourceContext: true,
        });
      } else {
        scopes.push({ phase: "none" });
      }
      continue;
    }
    if (token?.value === ")") {
      if (scopes.length === 1) return null;
      const child = scopes.pop();
      const parentIndex = scopes.length - 1;
      const parent = scopes[parentIndex];
      if (
        child?.phase === "after_table" &&
        child.inheritsSourceContext &&
        parent?.phase === "expect_table"
      ) {
        scopes[parentIndex] = {
          phase: "after_table",
          tableName: child.tableName,
          tableSchema: child.tableSchema,
          inheritsSourceContext: parent.inheritsSourceContext,
        };
      }
      continue;
    }
    if (token === undefined) continue;
    const scope = scopes[scopeIndex];
    if (scope === undefined) return null;
    if (token.value === ";") {
      scopes[scopeIndex] = { phase: "none" };
      continue;
    }
    if (isSqlKeyword(token, "from") || isSqlKeyword(token, "join")) {
      scopes[scopeIndex] = expectIndexedByTable(scope);
      continue;
    }
    if (isSqlKeyword(token, "update")) {
      scopes[scopeIndex] = {
        phase: "expect_update_table",
        tableSchema: undefined,
        inheritsSourceContext: inheritsIndexedBySourceContext(scope),
      };
      continue;
    }
    if (scope.phase === "none") continue;
    if (token.value === ",") {
      scopes[scopeIndex] = expectIndexedByTable(scope);
      continue;
    }
    if (token.value === ".") {
      if (scope.phase === "after_table") {
        scopes[scopeIndex] = expectIndexedByTable(scope, scope.tableName);
      }
      continue;
    }
    if (scope.phase === "expect_alias") {
      if (!isSqlNameToken(token)) {
        scopes[scopeIndex] = { phase: "none" };
        continue;
      }
      scopes[scopeIndex] = {
        phase: "after_table",
        tableName: scope.tableName,
        tableSchema: scope.tableSchema,
        inheritsSourceContext: scope.inheritsSourceContext,
      };
      continue;
    }
    if (isSqlKeyword(token, "indexed") && isSqlKeyword(tokens[position + 1], "by")) {
      const previous = tokens[position - 1];
      if (
        scope.phase === "after_table" &&
        isSqlNameToken(previous) &&
        !isSqlKeyword(previous, "as")
      ) {
        const indexToken = tokens[position + 2];
        if (!isSqlNameToken(indexToken)) return null;
        references.push({
          token: indexToken,
          indexName: indexToken.value,
          tableName: scope.tableName,
          tableSchema: scope.tableSchema,
          source: indexedByReferenceUsesCte(cteScopes, position, scope.tableName, scope.tableSchema)
            ? { kind: "cte" }
            : { kind: "table" },
        });
      } else if (scope.phase === "expect_table") {
        scopes[scopeIndex] = {
          phase: "after_table",
          tableName: token.value,
          tableSchema: scope.tableSchema,
          inheritsSourceContext: scope.inheritsSourceContext,
        };
      }
      continue;
    }
    if (scope.phase === "expect_update_table") {
      if (isSqlKeyword(token, "or")) {
        scopes[scopeIndex] = {
          phase: "expect_update_modifier",
          tableSchema: scope.tableSchema,
          inheritsSourceContext: scope.inheritsSourceContext,
        };
        continue;
      }
      if (isSqlNameToken(token)) {
        scopes[scopeIndex] = {
          phase: "after_table",
          tableName: token.value,
          tableSchema: scope.tableSchema,
          inheritsSourceContext: scope.inheritsSourceContext,
        };
      }
      continue;
    }
    if (scope.phase === "expect_update_modifier") {
      if (
        token.kind === "identifier" &&
        INDEXED_BY_UPDATE_MODIFIERS.has(token.value.toLowerCase())
      ) {
        scopes[scopeIndex] = expectIndexedByTable(scope);
      } else {
        scopes[scopeIndex] = { phase: "none" };
      }
      continue;
    }
    if (scope.phase === "expect_table") {
      if (isSqlNameToken(token)) {
        scopes[scopeIndex] = {
          phase: "after_table",
          tableName: token.value,
          tableSchema: scope.tableSchema,
          inheritsSourceContext: scope.inheritsSourceContext,
        };
      }
      continue;
    }
    if (scope.phase === "after_table") {
      if (isSqlKeyword(token, "as")) {
        scopes[scopeIndex] = {
          phase: "expect_alias",
          tableName: scope.tableName,
          tableSchema: scope.tableSchema,
          inheritsSourceContext: scope.inheritsSourceContext,
        };
        continue;
      }
      if (
        token.kind === "identifier" &&
        INDEXED_BY_SOURCE_BOUNDARIES.has(token.value.toLowerCase()) &&
        !(isSqlKeyword(tokens[position + 1], "indexed") && isSqlKeyword(tokens[position + 2], "by"))
      ) {
        scopes[scopeIndex] = { phase: "none" };
      }
    }
  }
  return references;
}

function rewriteIndexedBySql(
  definition: string,
  replacements: ReadonlyMap<string, string>,
): string | null {
  const references = indexedByReferences(definition);
  if (references === null) return null;
  const replacementsToApply = references
    .map((reference) => ({
      token: reference.token,
      name: replacements.get(reference.indexName.toLowerCase()),
    }))
    .filter((value): value is { token: SqlToken; name: string } => value.name !== undefined);
  if (replacementsToApply.length === 0) return definition;

  let rewritten = definition;
  for (const { token, name } of [...replacementsToApply].reverse()) {
    rewritten = `${rewritten.slice(0, token.start)}${quoteIdentifier(name)}${rewritten.slice(token.end)}`;
  }
  return rewritten;
}

function singleSqlStatement(tokens: readonly SqlToken[]): readonly SqlToken[] | null {
  const semicolon = tokens.findIndex((token) => token.value === ";");
  if (semicolon < 0) return tokens;
  return tokens.slice(semicolon + 1).length === 0 ? tokens.slice(0, semicolon) : null;
}

function comparableSqlToken(token: SqlToken): string {
  if (token.kind === "identifier" || token.kind === "quoted_identifier") {
    return `identifier:${normalizeSqliteIdentifier(token.value)}`;
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
    if (token?.kind !== "identifier" || !sameSqliteIdentifier(token.value, "check")) {
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
    !sameSqliteIdentifier(tokens[0].value, "create") ||
    tokens[1]?.kind !== "identifier" ||
    !sameSqliteIdentifier(tokens[1].value, "table")
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
  if (sameSqliteIdentifier(tableToken.value, probeName)) return null;
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

function executableSchemaDefinition(db: Database, definition: string): boolean {
  if (sqliteTokens(definition) === null) return false;
  try {
    const query = db.query(`EXPLAIN ${definition}`);
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
  return token?.kind === "identifier" && sameSqliteIdentifier(token.value, keyword);
}

type TriggerTiming = "before" | "after" | "instead of";

type TriggerEvent =
  { kind: "insert" } | { kind: "delete" } | { kind: "update"; columns: readonly string[] };

interface ParsedTriggerDefinition {
  name: string;
  table: string;
  tableToken: SqlToken;
  timing: TriggerTiming;
  event: TriggerEvent;
  forEachRow: boolean;
  when: readonly SqlToken[];
  body: readonly SqlToken[];
}

interface TriggerContract {
  name: string;
  table: string;
  timing: TriggerTiming;
  event: TriggerEvent;
  forEachRow: boolean;
  when: string;
  body: string;
}

const VIEWS_MIGRATION_TRIGGER_CONTRACTS = [
  {
    name: "saved_views_workspace_scope_insert",
    table: "saved_views",
    timing: "after",
    event: { kind: "insert" },
    forEachRow: false,
    when: "NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1",
    body: "UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;",
  },
  {
    name: "saved_views_workspace_required_insert",
    table: "saved_views",
    timing: "before",
    event: { kind: "insert" },
    forEachRow: false,
    when: "NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1",
    body: "SELECT RAISE(ABORT, 'Workspace context is required for saved_views');",
  },
  {
    name: "saved_views_workspace_required_update",
    table: "saved_views",
    timing: "before",
    event: { kind: "update", columns: ["workspace_id"] },
    forEachRow: false,
    when: "NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1",
    body: "SELECT RAISE(ABORT, 'Workspace context is required for saved_views');",
  },
] satisfies readonly TriggerContract[];

interface ViewsMigrationTriggerSnapshot {
  name: string;
  table: string;
  sql: string;
  recreatedSql: string;
  canonical: boolean;
}

interface WorkspaceConstraintTriggerSnapshot {
  name: string;
  table: string;
  sql: string;
  recreatedSql: string;
  canonical: boolean;
}

const VIEWS_MIGRATION_CANONICAL_TRIGGER_NAMES = new Set(
  VIEWS_MIGRATION_TRIGGER_CONTRACTS.map((contract) => contract.name.toLowerCase()),
);

function isViewsMigrationCanonicalTrigger(name: string): boolean {
  return VIEWS_MIGRATION_CANONICAL_TRIGGER_NAMES.has(name.toLowerCase());
}

/**
 * Los triggers contienen sentencias separadas por `;` dentro de BEGIN/END.
 * El tokenizer de PRB-641 ya excluye comentarios y conserva literales; aquí se
 * elimina solo el punto y coma final opcional antes de analizar la definición.
 */
function triggerStatementTokens(definition: string): readonly SqlToken[] | null {
  const parsed = sqliteTokens(definition);
  if (parsed === null) return null;
  const last = parsed[parsed.length - 1];
  return last?.value === ";" ? parsed.slice(0, -1) : parsed;
}

function triggerBeginPosition(tokens: readonly SqlToken[], start: number): number | null {
  let depth = 0;
  for (let position = start; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token?.value === "(") {
      depth += 1;
      continue;
    }
    if (token?.value === ")") {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    if (depth === 0 && isSqlKeyword(token, "begin")) return position;
  }
  return null;
}

function triggerDefinitionFromSql(definition: string): ParsedTriggerDefinition | null {
  const tokens = triggerStatementTokens(definition);
  if (tokens === null) return null;

  let position = 0;
  if (!isSqlKeyword(tokens[position], "create")) return null;
  position += 1;
  if (isSqlKeyword(tokens[position], "temp")) position += 1;
  if (!isSqlKeyword(tokens[position], "trigger")) return null;
  position += 1;
  if (isSqlKeyword(tokens[position], "if")) {
    if (!isSqlKeyword(tokens[position + 1], "not")) return null;
    if (!isSqlKeyword(tokens[position + 2], "exists")) return null;
    position += 3;
  }

  const nameToken = tokens[position];
  if (!isSqlNameToken(nameToken)) return null;
  position += 1;

  let timing: TriggerTiming;
  if (isSqlKeyword(tokens[position], "before")) {
    timing = "before";
    position += 1;
  } else if (isSqlKeyword(tokens[position], "after")) {
    timing = "after";
    position += 1;
  } else if (isSqlKeyword(tokens[position], "instead")) {
    if (!isSqlKeyword(tokens[position + 1], "of")) return null;
    timing = "instead of";
    position += 2;
  } else {
    return null;
  }

  let event: TriggerEvent;
  if (isSqlKeyword(tokens[position], "insert")) {
    event = { kind: "insert" };
    position += 1;
  } else if (isSqlKeyword(tokens[position], "delete")) {
    event = { kind: "delete" };
    position += 1;
  } else if (isSqlKeyword(tokens[position], "update")) {
    position += 1;
    const columns: string[] = [];
    if (isSqlKeyword(tokens[position], "of")) {
      position += 1;
      const firstColumn = tokens[position];
      if (!isSqlNameToken(firstColumn)) return null;
      columns.push(firstColumn.value);
      position += 1;
      while (tokens[position]?.value === ",") {
        position += 1;
        const column = tokens[position];
        if (!isSqlNameToken(column)) return null;
        columns.push(column.value);
        position += 1;
      }
    }
    event = { kind: "update", columns };
  } else {
    return null;
  }

  if (!isSqlKeyword(tokens[position], "on")) return null;
  position += 1;
  const tableToken = tokens[position];
  if (!isSqlNameToken(tableToken)) return null;
  position += 1;
  let tableName = tableToken.value;
  if (tokens[position]?.value === ".") {
    const qualifiedTableToken = tokens[position + 1];
    if (!isSqlNameToken(qualifiedTableToken)) return null;
    tableName = qualifiedTableToken.value;
    position += 2;
  }

  let forEachRow = false;
  if (isSqlKeyword(tokens[position], "for")) {
    if (!isSqlKeyword(tokens[position + 1], "each") || !isSqlKeyword(tokens[position + 2], "row")) {
      return null;
    }
    forEachRow = true;
    position += 3;
  }

  let when: readonly SqlToken[] = [];
  if (isSqlKeyword(tokens[position], "when")) {
    position += 1;
    const begin = triggerBeginPosition(tokens, position);
    if (begin === null || begin === position) return null;
    when = tokens.slice(position, begin);
    position = begin;
  }

  if (!isSqlKeyword(tokens[position], "begin")) return null;
  const end = tokens.length - 1;
  if (!isSqlKeyword(tokens[end], "end") || end <= position + 1) return null;

  return {
    name: nameToken.value,
    table: tableName,
    tableToken,
    timing,
    event,
    forEachRow,
    when,
    body: tokens.slice(position + 1, end),
  };
}

function triggerEndPosition(tokens: readonly SqlToken[], start: number): number | null {
  let depth = 0;
  for (let position = start; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token?.value === "(") {
      depth += 1;
      continue;
    }
    if (token?.value === ")") {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    if (depth === 0 && isSqlKeyword(token, "end")) {
      const next = tokens[position + 1];
      if (next === undefined || next.value === ";") return position;
    }
  }
  return null;
}

/**
 * Obtiene los contratos semánticos de los triggers que 0025 crea. El SQL de la
 * migración es la fuente canónica; el análisis usa los mismos tokens que el
 * preflight y no busca fragmentos textuales dentro de comentarios o literales.
 */
function migrationTriggerDefinitions(sql: string): Map<string, ParsedTriggerDefinition> {
  const tokens = sqliteTokens(sql);
  const definitions = new Map<string, ParsedTriggerDefinition>();
  if (tokens === null) return definitions;

  for (let position = 0; position < tokens.length; position += 1) {
    if (
      !isSqlKeyword(tokens[position], "create") ||
      !isSqlKeyword(tokens[position + 1], "trigger")
    ) {
      continue;
    }
    const begin = triggerBeginPosition(tokens, position + 2);
    if (begin === null) continue;
    const end = triggerEndPosition(tokens, begin + 1);
    const startToken = tokens[position];
    const endToken = end === null ? undefined : tokens[end];
    if (startToken === undefined || endToken === undefined) continue;
    const definition = sql.slice(startToken.start, endToken.end);
    const parsed = triggerDefinitionFromSql(definition);
    if (parsed !== null) definitions.set(parsed.name.toLowerCase(), parsed);
    if (end !== null) position = end;
  }
  return definitions;
}

const WORKSPACE_CONSTRAINTS_CANONICAL_TRIGGER_DEFINITIONS = new Map(
  [...migrationTriggerDefinitions(migration0025)].filter(([, definition]) =>
    WORKSPACE_CONSTRAINTS_REBUILT_TABLES.some(
      (table) => table.toLowerCase() === definition.table.toLowerCase(),
    ),
  ),
);

function renamedTriggerSql(
  definition: string,
  name: string,
  expectedTable: string,
  expectedName: string,
): string | null {
  const parsed = triggerStatementTokens(definition);
  if (parsed === null) return null;
  if (!isSqlKeyword(parsed[0], "create")) return null;
  let position = 1;
  if (isSqlKeyword(parsed[position], "temp")) position += 1;
  if (!isSqlKeyword(parsed[position], "trigger")) return null;
  position += 1;
  if (isSqlKeyword(parsed[position], "if")) {
    if (!isSqlKeyword(parsed[position + 1], "not")) return null;
    if (!isSqlKeyword(parsed[position + 2], "exists")) return null;
    position += 3;
  }
  const triggerToken = parsed[position];
  if (!isSqlNameToken(triggerToken) || !sameSqliteIdentifier(triggerToken.value, expectedName)) {
    return null;
  }
  const actual = triggerDefinitionFromSql(definition);
  if (
    actual === null ||
    !sameSqliteIdentifier(actual.name, expectedName) ||
    !sameSqliteIdentifier(actual.table, expectedTable)
  ) {
    return null;
  }
  return `${definition.slice(0, triggerToken.start)}${quoteIdentifier(name)}${definition.slice(triggerToken.end)}`;
}

function triggerSqlForTable(
  definition: string,
  expectedName: string,
  expectedTable: string,
  targetTable: string,
): string | null {
  const actual = triggerDefinitionFromSql(definition);
  if (
    actual === null ||
    actual.name.toLowerCase() !== expectedName.toLowerCase() ||
    actual.table.toLowerCase() !== expectedTable.toLowerCase()
  ) {
    return null;
  }
  if (actual.table.toLowerCase() === targetTable.toLowerCase()) return definition;
  return `${definition.slice(0, actual.tableToken.start)}${quoteIdentifier(targetTable)}${definition.slice(actual.tableToken.end)}`;
}

function triggerOperationForExplain(
  db: Database,
  definition: ParsedTriggerDefinition,
): string | null {
  const table = quoteIdentifier(definition.table);
  switch (definition.event.kind) {
    case "insert":
      return `EXPLAIN INSERT INTO ${table} DEFAULT VALUES`;
    case "delete":
      return `EXPLAIN DELETE FROM ${table} WHERE 0`;
    case "update": {
      const columns = tableInfo(db, definition.table);
      if (
        definition.event.columns.some(
          (column) => !columns.some((value) => value.name.toLowerCase() === column.toLowerCase()),
        )
      ) {
        return null;
      }
      const column = definition.event.columns[0] ?? columns[0]?.name;
      if (column === undefined) return null;
      const quotedColumn = quoteIdentifier(column);
      return `EXPLAIN UPDATE ${table} SET ${quotedColumn} = ${quotedColumn} WHERE 0`;
    }
    default: {
      const _exhaustive: never = definition.event;
      return _exhaustive;
    }
  }
}

function triggerSchemaDefinitionForExplain(db: Database, definition: string): string | null {
  const parsed = triggerDefinitionFromSql(definition);
  if (parsed === null) return null;

  let probeName = "__prb654_trigger_probe";
  let suffix = 1;
  while (schemaObjectsWithName(db, probeName).length > 0) {
    suffix += 1;
    probeName = `__prb654_trigger_probe_${suffix}`;
  }
  return renamedTriggerSql(definition, probeName, parsed.table, parsed.name);
}

function executableTriggerSchemaDefinition(db: Database, definition: string): boolean {
  const explainable = triggerSchemaDefinitionForExplain(db, definition);
  return explainable !== null && executableSchemaDefinition(db, explainable);
}

function executableTriggerDefinition(db: Database, definition: string): boolean {
  const parsed = triggerDefinitionFromSql(definition);
  if (parsed === null || !executableTriggerSchemaDefinition(db, definition)) return false;

  const operation = triggerOperationForExplain(db, parsed);
  if (operation === null) return false;
  try {
    const query = db.query(operation);
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

function renamedViewSql(definition: string, name: string, expectedName: string): string | null {
  const parsed = sqliteTokens(definition);
  if (parsed === null) return null;
  const tokens = singleSqlStatement(parsed);
  if (!tokens || !isSqlKeyword(tokens[0], "create")) return null;
  let position = 1;
  if (isSqlKeyword(tokens[position], "temp")) position += 1;
  if (!isSqlKeyword(tokens[position], "view")) return null;
  position += 1;
  if (isSqlKeyword(tokens[position], "if")) {
    if (!isSqlKeyword(tokens[position + 1], "not")) return null;
    if (!isSqlKeyword(tokens[position + 2], "exists")) return null;
    position += 3;
  }
  const viewToken = tokens[position];
  if (!isSqlNameToken(viewToken) || !sameSqliteIdentifier(viewToken.value, expectedName)) {
    return null;
  }
  position += 1;

  let depth = 0;
  let asPosition = -1;
  for (; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token?.value === "(") {
      depth += 1;
      continue;
    }
    if (token?.value === ")") {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    if (depth === 0 && isSqlKeyword(token, "as")) {
      asPosition = position;
      break;
    }
  }
  if (asPosition < 0 || asPosition === tokens.length - 1) return null;
  return `${definition.slice(0, viewToken.start)}${quoteIdentifier(name)}${definition.slice(viewToken.end)}`;
}

function sqlReferencesIdentifier(sql: string, name: string): boolean {
  const parsed = sqliteTokens(sql);
  return (
    parsed !== null &&
    parsed.some(
      (token) =>
        (token.kind === "identifier" || token.kind === "quoted_identifier") &&
        sameSqliteIdentifier(token.value, name),
    )
  );
}

type SchemaObjectsFilter = "with_sql" | "views_and_triggers";

function schemaObjectsFromMaster(
  db: Database,
  temporary: boolean,
  filter: SchemaObjectsFilter,
): Array<{ object: SchemaObjectRow; temporary: boolean }> {
  const master = temporary ? "sqlite_temp_master" : "sqlite_master";
  const where = filter === "with_sql" ? "sql IS NOT NULL" : "type IN ('view', 'trigger')";
  return db
    .query<SchemaObjectRow, SQLQueryBindings[]>(
      `SELECT type, name, tbl_name, sql FROM ${master} WHERE ${where}`,
    )
    .all()
    .map((object) => ({ object, temporary }));
}

function schemaObjectsWithDependencies(
  db: Database,
): Array<{ object: SchemaObjectRow; temporary: boolean }> {
  return [
    ...schemaObjectsFromMaster(db, false, "with_sql"),
    ...schemaObjectsFromMaster(db, true, "with_sql"),
  ];
}

function temporarySchemaDefinition(definition: string, type: "view" | "trigger"): string | null {
  const tokens = sqliteTokens(definition);
  if (tokens === null) return null;
  const createToken = tokens[0];
  if (createToken === undefined || !isSqlKeyword(createToken, "create")) return null;
  if (isSqlKeyword(tokens[1], "temp")) return definition;
  if (!isSqlKeyword(tokens[1], type)) return null;
  return `${definition.slice(0, createToken.end)} TEMP${definition.slice(createToken.end)}`;
}

type RenamedSchemaObjectSqlOptions =
  | { type: "view"; definition: string; name: string; expectedName: string }
  | {
      type: "trigger";
      definition: string;
      name: string;
      expectedTable: string;
      expectedName: string;
    };

function renamedSchemaObjectSql(options: RenamedSchemaObjectSqlOptions): string | null {
  switch (options.type) {
    case "view":
      return renamedViewSql(options.definition, options.name, options.expectedName);
    case "trigger":
      return renamedTriggerSql(
        options.definition,
        options.name,
        options.expectedTable,
        options.expectedName,
      );
    default: {
      const _exhaustive: never = options;
      return _exhaustive;
    }
  }
}

function indexedByReferenceUsesExistingIndex({
  db,
  reference,
}: {
  db: Database;
  reference: IndexedByReference;
}): boolean {
  switch (reference.source.kind) {
    case "cte":
      return false;
    case "table":
      break;
    default: {
      const _exhaustive: never = reference.source;
      return _exhaustive;
    }
  }
  const schema = reference.tableSchema?.toLowerCase();
  if (schema !== undefined && schema !== "main" && schema !== "temp") return false;
  const schemas =
    schema === "main"
      ? ["sqlite_master"]
      : schema === "temp"
        ? ["sqlite_temp_master"]
        : ["sqlite_temp_master", "sqlite_master"];
  for (const master of schemas) {
    const table = db
      .query<SchemaObjectRow, SQLQueryBindings[]>(
        `SELECT type, name, tbl_name, sql FROM ${master} ` +
          "WHERE type IN ('table', 'view') AND lower(name) = lower(?1)",
      )
      .get(reference.tableName);
    if (table === null) continue;
    if (table.type !== "table") return false;
    return (
      db
        .query(
          `SELECT 1 FROM ${master}
           WHERE type = 'index' AND lower(name) = lower(?1) AND lower(tbl_name) = lower(?2)`,
        )
        .get(reference.indexName, table.name) !== null
    );
  }
  return false;
}

function schemaObjectsWithIndexedByDependencies(
  db: Database,
  migrationVersion: 32 | 33 = 33,
): IndexedByDependency[] {
  const objects = [
    ...schemaObjectsFromMaster(db, false, "views_and_triggers"),
    ...schemaObjectsFromMaster(db, true, "views_and_triggers"),
  ];
  const dependencies: IndexedByDependency[] = [];
  for (const { object, temporary } of objects) {
    if (!isRecreatedSchemaObject(object)) continue;
    if (object.sql === null) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: ${temporary ? "temporary " : ""}${object.type} ` +
          `${object.name} has no recoverable definition`,
      );
    }
    const references = indexedByReferences(object.sql);
    if (references === null) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: ${temporary ? "temporary " : ""}${object.type} ` +
          `${object.name} has an invalid definition`,
      );
    }
    for (const reference of references) {
      if (reference.source.kind === "cte") {
        throw new Error(
          `Cannot apply migration ${migrationVersion} safely: ${temporary ? "temporary " : ""}${object.type} ` +
            `${object.name} uses INDEXED BY ${reference.indexName} on CTE ${reference.tableName}`,
        );
      }
      if (!indexedByReferenceUsesExistingIndex({ db, reference })) {
        throw new Error(
          `Cannot apply migration ${migrationVersion} safely: ${temporary ? "temporary " : ""}${object.type} ` +
            `${object.name} references missing or unrelated index ${reference.indexName} for table ` +
            `${reference.tableName}`,
        );
      }
    }
    if (references.length === 0) continue;
    const type = object.type;
    const executable = temporary ? temporarySchemaDefinition(object.sql, type) : object.sql;
    if (
      executable === null ||
      !executableIndexedByDependencyDefinition({
        db,
        dependency: { object, temporary },
        definition: executable,
      })
    ) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: cannot recreate ${temporary ? "temporary " : ""}` +
          `${type} ${object.name} with its INDEXED BY dependency`,
      );
    }
    dependencies.push({
      object,
      temporary,
      indexNames: references.map((reference) => reference.indexName),
    });
  }
  return dependencies;
}

function schemaObjectsWithName(
  db: Database,
  name: string,
): Array<{ object: SchemaObjectRow; temporary: boolean }> {
  const mainObjects = db
    .query<SchemaObjectRow, SQLQueryBindings[]>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ?1 COLLATE NOCASE",
    )
    .all(name)
    .map((object) => ({ object, temporary: false }));
  const temporaryObjects = db
    .query<SchemaObjectRow, SQLQueryBindings[]>(
      "SELECT type, name, tbl_name, sql FROM sqlite_temp_master WHERE name = ?1 COLLATE NOCASE",
    )
    .all(name)
    .map((object) => ({ object, temporary: true }));
  return [...mainObjects, ...temporaryObjects];
}

function sqlIdentifierOccurrences(sql: string, name: string): number {
  const tokens = sqliteTokens(sql);
  return (
    tokens?.filter(
      (token) =>
        (token.kind === "identifier" || token.kind === "quoted_identifier") &&
        sameSqliteIdentifier(token.value, name),
    ).length ?? 0
  );
}

function viewHasSchemaDependencies(db: Database, view: SchemaObjectRow): boolean {
  if (view.sql !== null) {
    // Una aparición corresponde al nombre de CREATE VIEW. Una segunda puede ser
    // una referencia recursiva o un nombre de la consulta; ambas son inseguras
    // si solo se cambia el nombre del objeto.
    if (sqlIdentifierOccurrences(view.sql, view.name) > 1) return true;
  }
  return schemaObjectsWithDependencies(db).some(({ object, temporary }) => {
    if (object.type === "view" && sameSqliteIdentifier(object.name, view.name)) {
      if (!temporary) return false;
      // Una TEMP VIEW puede ocultar intencionadamente un objeto del esquema
      // principal. Solo es una dependencia si su consulta menciona la View
      // coincidente después de su propio nombre.
      return object.sql !== null && sqlIdentifierOccurrences(object.sql, view.name) > 1;
    }
    return (
      sameSqliteIdentifier(object.tbl_name, view.name) ||
      (object.sql !== null && sqlReferencesIdentifier(object.sql, view.name))
    );
  });
}

function sameTriggerEvent(left: TriggerEvent, right: TriggerEvent): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "update" || right.kind !== "update") return true;
  return (
    left.columns.length === right.columns.length &&
    left.columns.every((column, position) => {
      const expected = right.columns[position];
      return expected !== undefined && sameSqliteIdentifier(column, expected);
    })
  );
}

function sameTriggerBehavior(
  left: ParsedTriggerDefinition,
  right: ParsedTriggerDefinition,
): boolean {
  return (
    left.timing === right.timing &&
    sameTriggerEvent(left.event, right.event) &&
    left.forEachRow === right.forEachRow &&
    sameSqlTokens(comparableSqlTokens(left.when), comparableSqlTokens(right.when)) &&
    sameSqlTokens(comparableSqlTokens(left.body), comparableSqlTokens(right.body))
  );
}

function matchesTriggerContract(
  definition: TriggerDefinitionRow | null,
  contract: TriggerContract,
): boolean {
  if (
    definition === null ||
    typeof definition.name !== "string" ||
    typeof definition.tbl_name !== "string" ||
    typeof definition.sql !== "string"
  ) {
    return false;
  }
  const actual = triggerDefinitionFromSql(definition.sql);
  const expectedWhen = sqliteTokens(contract.when);
  const expectedBody = sqliteTokens(contract.body);
  return (
    sameSqliteIdentifier(definition.name, contract.name) &&
    sameSqliteIdentifier(definition.tbl_name, contract.table) &&
    actual !== null &&
    sameSqliteIdentifier(actual.name, contract.name) &&
    sameSqliteIdentifier(actual.table, contract.table) &&
    actual.timing === contract.timing &&
    sameTriggerEvent(actual.event, contract.event) &&
    actual.forEachRow === contract.forEachRow &&
    expectedWhen !== null &&
    sameSqlTokens(comparableSqlTokens(actual.when), comparableSqlTokens(expectedWhen)) &&
    expectedBody !== null &&
    sameSqlTokens(comparableSqlTokens(actual.body), comparableSqlTokens(expectedBody))
  );
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

function renamedIndexSql(
  definition: string,
  name: string,
  expectedTable = "saved_views",
  expectedName?: string,
): string | null {
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
    !sameSqliteIdentifier(tableToken.value, expectedTable) ||
    (expectedName !== undefined && !sameSqliteIdentifier(indexToken.value, expectedName))
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
  const index = indexList(db, "view_preferences").find((value) =>
    sameSqliteIdentifier(value.name, "idx_view_preferences_key"),
  );
  if (!index || index.unique_value !== 1 || index.partial !== 0) return false;

  const definition = db
    .query<SqlDefinitionRow, SQLQueryBindings[]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1 COLLATE NOCASE",
    )
    .get("idx_view_preferences_key");
  if (!definition?.sql) return false;

  const parsed = indexDefinitionFromSql(definition.sql);
  if (
    !parsed ||
    !parsed.unique ||
    !sameSqliteIdentifier(parsed.name, index.name) ||
    !sameSqliteIdentifier(parsed.table, "view_preferences")
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
      (expected.column === null
        ? term.name === null
        : term.name !== null && sameSqliteIdentifier(term.name, expected.column)) &&
      term.desc === 0 &&
      sameSqliteIdentifier(term.coll, "BINARY") &&
      sameSqlTokens(comparableSqlTokens(actualSql), expectedSql)
    );
  });
}

function savedViewsIndexDefinitions(db: Database): SavedViewsIndexDefinition[] {
  return indexList(db, "saved_views").map((index) => {
    const definition = db
      .query<SqlDefinitionRow, SQLQueryBindings[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1 COLLATE NOCASE",
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

function indexPredicateTokensFromDefinition(definition: string): readonly SqlToken[] | null {
  const parsed = sqliteTokens(definition);
  if (parsed === null) return null;
  const tokens = singleSqlStatement(parsed);
  if (tokens === null) return null;
  let depth = 0;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token?.value === "(") {
      depth += 1;
      continue;
    }
    if (token?.value === ")") {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    if (depth === 0 && isSqlKeyword(token, "where")) {
      const predicate = tokens.slice(position + 1);
      return predicate.length > 0 ? predicate : null;
    }
  }
  return depth === 0 ? [] : null;
}

function indexPredicateTokens(db: Database, name: string): readonly SqlToken[] | null {
  const definition = db
    .query<SqlDefinitionRow, SQLQueryBindings[]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND lower(name) = lower(?1)",
    )
    .get(name);
  return definition?.sql === null || definition?.sql === undefined
    ? null
    : indexPredicateTokensFromDefinition(definition.sql);
}

function equivalentIndexName(
  db: Database,
  table: string,
  terms: readonly IndexTermRow[],
  unique: boolean,
  origin?: string,
  partial = 0,
  predicate?: readonly SqlToken[],
): string | null {
  return (
    indexList(db, table).find((index) => {
      if (origin !== undefined && index.origin !== origin) return false;
      if (partial !== 0) {
        if (predicate === undefined) return false;
        const actualPredicate = indexPredicateTokens(db, index.name);
        if (
          actualPredicate === null ||
          !sameSqlTokens(comparableSqlTokens(actualPredicate), comparableSqlTokens(predicate))
        ) {
          return false;
        }
      }
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
            (term.name === null
              ? expected.name === null
              : expected.name !== null && sameSqliteIdentifier(term.name, expected.name)) &&
            term.desc === expected.desc &&
            sameSqliteIdentifier(term.coll, expected.coll)
          );
        })
      );
    })?.name ?? null
  );
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

type ViewsMigrationNamedIndex =
  | { kind: "key"; name: "idx_view_preferences_key"; table: "view_preferences" }
  | {
      kind: "columns";
      name: string;
      table: string;
      columns: readonly string[];
      unique: boolean;
    };

const VIEWS_MIGRATION_NAMED_INDEXES = [
  {
    kind: "columns",
    name: "idx_saved_views_workspace_id",
    table: "saved_views",
    columns: ["workspace_id", "id"],
    unique: true,
  },
  {
    kind: "columns",
    name: "idx_saved_views_scope",
    table: "saved_views",
    columns: ["scope", "team_id"],
    unique: false,
  },
  {
    kind: "columns",
    name: "idx_saved_views_owner",
    table: "saved_views",
    columns: ["owner_id"],
    unique: false,
  },
  {
    kind: "columns",
    name: "idx_saved_views_project",
    table: "saved_views",
    columns: ["workspace_id", "project_id"],
    unique: false,
  },
  {
    kind: "columns",
    name: "idx_saved_views_initiative",
    table: "saved_views",
    columns: ["workspace_id", "initiative_id"],
    unique: false,
  },
  { kind: "key", name: "idx_view_preferences_key", table: "view_preferences" },
  {
    kind: "columns",
    name: "idx_view_preferences_view",
    table: "view_preferences",
    columns: ["workspace_id", "view_id"],
    unique: false,
  },
  {
    kind: "columns",
    name: "idx_view_preferences_actor",
    table: "view_preferences",
    columns: ["workspace_id", "actor_id"],
    unique: false,
  },
  {
    kind: "columns",
    name: "idx_view_subscriptions_view",
    table: "view_subscriptions",
    columns: ["workspace_id", "view_id"],
    unique: false,
  },
  {
    kind: "columns",
    name: "idx_view_subscriptions_actor",
    table: "view_subscriptions",
    columns: ["workspace_id", "actor_id"],
    unique: false,
  },
] satisfies readonly ViewsMigrationNamedIndex[];

const VIEWS_MIGRATION_CREATED_TABLES = [
  "_prb390_saved_views",
  "view_preferences",
  "view_subscriptions",
] satisfies readonly string[];

interface MigrationNameCollision {
  type: "index" | "trigger" | "view";
  name: string;
  table: string;
  replacementName: string;
  sql: string;
  temporary: boolean;
}

type IndexedByDependency = {
  object: RecreatedSchemaObject;
  temporary: boolean;
  indexNames: readonly string[];
};

function migrationObjectNameInUse(db: Database, name: string): boolean {
  return schemaObjectsWithName(db, name).some(({ object }) => object.type !== "trigger");
}

function triggerNameInUse(db: Database, name: string): boolean {
  return schemaObjects(db, name).some((object) => object.type === "trigger");
}

function generatedMigrationIndexName(
  db: Database,
  name: string,
  plannedNames: Set<string>,
  nameInUse = migrationObjectNameInUse,
): string {
  const base = `${name}_legacy`;
  for (let suffixNumber = 1; ; suffixNumber += 1) {
    const candidate = suffixNumber === 1 ? base : `${base}_${suffixNumber}`;
    if (!nameInUse(db, candidate) && !plannedNames.has(normalizeSqliteIdentifier(candidate))) {
      plannedNames.add(normalizeSqliteIdentifier(candidate));
      return candidate;
    }
  }
}

function generatedViewsMigrationTriggerName(
  db: Database,
  name: string,
  plannedNames: Set<string>,
): string {
  const base = `${name}_legacy`;
  for (let suffixNumber = 1; ; suffixNumber += 1) {
    const candidate = suffixNumber === 1 ? base : `${base}_${suffixNumber}`;
    if (
      !triggerNameInUse(db, candidate) &&
      !plannedNames.has(normalizeSqliteIdentifier(candidate))
    ) {
      plannedNames.add(normalizeSqliteIdentifier(candidate));
      return candidate;
    }
  }
}

function generatedMigrationViewName(
  db: Database,
  name: string,
  plannedNames: Set<string>,
  nameInUse = migrationObjectNameInUse,
): string {
  const base = `${name}_legacy`;
  for (let suffixNumber = 1; ; suffixNumber += 1) {
    const candidate = suffixNumber === 1 ? base : `${base}_${suffixNumber}`;
    if (!nameInUse(db, candidate) && !plannedNames.has(normalizeSqliteIdentifier(candidate))) {
      plannedNames.add(normalizeSqliteIdentifier(candidate));
      return candidate;
    }
  }
}

function viewsMigrationIndexMatches(db: Database, expected: ViewsMigrationNamedIndex): boolean {
  if (expected.kind === "key") return hasViewPreferencesKeyIndex(db);
  return hasNamedIndexWithColumns(
    db,
    expected.table,
    expected.name,
    expected.columns,
    expected.unique,
  );
}

function viewsMigrationIndexHasEquivalentAlternative(
  db: Database,
  expected: ViewsMigrationNamedIndex,
): boolean {
  return (
    expected.kind === "columns" &&
    expected.table === "saved_views" &&
    hasIndexWithColumns(db, expected.table, expected.columns, expected.unique)
  );
}

interface MigrationNameCollisionPlanOptions {
  reservedNames: readonly string[];
  errorPrefix: string;
  expectedIndexTable?: (name: string) => string | undefined;
  indexMatches?: (db: Database, name: string) => boolean;
  indexEquivalentAlternative?: (db: Database, name: string) => boolean;
  replacementNameInUse?: (db: Database, name: string) => boolean;
}

/**
 * Reserva nombres del namespace SQLite antes de ejecutar DDL. Las definiciones
 * recuperables se renombran dentro de la misma transacción; una TEMP siempre
 * bloquea porque puede ocultar el objeto main que el DDL no cualifica.
 */
function migrationNameCollisionPlan(
  db: Database,
  options: MigrationNameCollisionPlanOptions,
): MigrationNameCollision[] {
  const collisions: MigrationNameCollision[] = [];
  const plannedObjectNames = new Set(options.reservedNames.map(normalizeSqliteIdentifier));

  for (const name of options.reservedNames) {
    for (const { object, temporary } of schemaObjectsWithName(db, name)) {
      if (temporary) {
        throw new Error(
          `${options.errorPrefix}: temporary ${object.type} ${object.name} ` +
            `blocks the global index/table name ${name}`,
        );
      }
      if (object.type === "trigger") continue;
      if (object.type === "view") {
        if (viewHasSchemaDependencies(db, object)) {
          throw new Error(
            `${options.errorPrefix}: view ${object.name} has dependent schema objects`,
          );
        }
        if (object.sql === null) {
          throw new Error(`Cannot rename legacy view ${object.name} safely`);
        }
        const replacementName = generatedMigrationViewName(
          db,
          object.name,
          plannedObjectNames,
          options.replacementNameInUse,
        );
        const sql = renamedViewSql(object.sql, replacementName, object.name);
        if (sql === null || !executableSchemaDefinition(db, sql)) {
          throw new Error(`Cannot rename legacy view ${object.name} safely`);
        }
        collisions.push({
          type: "view",
          name: object.name,
          table: object.tbl_name,
          replacementName,
          sql,
          temporary: false,
        });
        continue;
      }
      if (object.type !== "index") {
        throw new Error(
          `${options.errorPrefix}: ${object.type} ${object.name} ` +
            `blocks the global index/table name ${name}`,
        );
      }

      const expectedTable = options.expectedIndexTable?.(name);
      if (expectedTable !== undefined && sameSqliteIdentifier(object.tbl_name, expectedTable)) {
        const matches = options.indexMatches?.(db, name) ?? false;
        const equivalent = options.indexEquivalentAlternative?.(db, name) ?? false;
        if (!matches && !equivalent) {
          throw new Error(
            `${options.errorPrefix}: same-table index ${object.name} on ` +
              `${object.tbl_name} is incompatible`,
          );
        }
        continue;
      }
      if (object.sql === null) {
        throw new Error(
          `${options.errorPrefix}: index ${object.name} has no recoverable definition`,
        );
      }
      const replacementName = generatedMigrationIndexName(
        db,
        object.name,
        plannedObjectNames,
        options.replacementNameInUse,
      );
      const sql = renamedIndexSql(object.sql, replacementName, object.tbl_name, object.name);
      if (sql === null || !executableSchemaDefinition(db, sql)) {
        throw new Error(`Cannot rename legacy index ${object.name} safely`);
      }
      collisions.push({
        type: "index",
        name: object.name,
        table: object.tbl_name,
        replacementName,
        sql,
        temporary: false,
      });
    }
  }

  return collisions;
}

function validateTemporaryTriggerBeforeRebuild(
  db: Database,
  table: string,
  migrationVersion: number,
): void {
  const temporaryTriggers = db
    .query<TriggerDefinitionRow, SQLQueryBindings[]>(
      "SELECT name, tbl_name, sql FROM sqlite_temp_master " +
        "WHERE type = 'trigger' AND lower(tbl_name) = lower(?1) ORDER BY rowid",
    )
    .all(table);
  const temporaryTrigger = temporaryTriggers[0];
  if (temporaryTrigger === undefined) return;

  const migrationLabel = migrationVersion.toString().padStart(4, "0");
  throw new Error(
    `Cannot apply migration ${migrationLabel} safely: temporary trigger ${temporaryTrigger.name} on ` +
      `${temporaryTrigger.tbl_name} would be lost while rebuilding ${table}`,
  );
}

function validateWorkspaceConstraintTemporaryTriggers(
  db: Database,
  migrationVersion: number,
): void {
  const temporaryTriggers = db
    .query<TriggerDefinitionRow, SQLQueryBindings[]>(
      "SELECT name, tbl_name, sql FROM sqlite_temp_master WHERE type = 'trigger' ORDER BY rowid",
    )
    .all();
  const migrationLabel = migrationVersion.toString().padStart(4, "0");
  for (const table of WORKSPACE_CONSTRAINTS_REBUILT_TABLES) {
    const temporaryTrigger = temporaryTriggers.find(
      (definition) =>
        typeof definition.tbl_name === "string" &&
        definition.tbl_name.toLowerCase() === table.toLowerCase(),
    );
    if (temporaryTrigger === undefined) continue;
    throw new Error(
      `Cannot apply migration ${migrationLabel} safely: temporary trigger ${temporaryTrigger.name} on ` +
        `${temporaryTrigger.tbl_name} would be lost while rebuilding ${table}`,
    );
  }
}

function viewsMigrationNameCollisionPlan(
  db: Database,
  includeCreatedTables = true,
): MigrationNameCollision[] {
  const indexByName = new Map(
    VIEWS_MIGRATION_NAMED_INDEXES.map((index) => [normalizeSqliteIdentifier(index.name), index]),
  );
  const reservedNames = [
    ...VIEWS_MIGRATION_NAMED_INDEXES.map((index) => index.name),
    ...(includeCreatedTables ? VIEWS_MIGRATION_CREATED_TABLES : []),
  ];
  const collisions = migrationNameCollisionPlan(db, {
    reservedNames,
    errorPrefix: "Cannot apply migration 0033 safely",
    expectedIndexTable: (name) => indexByName.get(normalizeSqliteIdentifier(name))?.table,
    indexMatches: (database, name) => {
      const expected = indexByName.get(normalizeSqliteIdentifier(name));
      return expected !== undefined && viewsMigrationIndexMatches(database, expected);
    },
    indexEquivalentAlternative: (database, name) => {
      const expected = indexByName.get(normalizeSqliteIdentifier(name));
      return (
        expected !== undefined && viewsMigrationIndexHasEquivalentAlternative(database, expected)
      );
    },
    replacementNameInUse: indexNameInUse,
  });
  const plannedTriggerNames = new Set<string>();

  if (includeCreatedTables) {
    validateTemporaryTriggerBeforeRebuild(db, "saved_views", 33);
  }

  for (const expected of VIEWS_MIGRATION_TRIGGER_CONTRACTS) {
    for (const object of schemaObjects(db, expected.name)) {
      if (object.type !== "trigger") continue;
      const definition: TriggerDefinitionRow = {
        name: object.name,
        tbl_name: object.tbl_name,
        sql: object.sql,
      };
      if (sameSqliteIdentifier(object.tbl_name, expected.table)) {
        if (!matchesTriggerContract(definition, expected)) {
          throw new Error(
            `Cannot apply migration 0033 safely: same-table trigger ${object.name} on ` +
              `${object.tbl_name} is incompatible`,
          );
        }
        continue;
      }
      if (object.sql === null) {
        throw new Error(
          `Cannot apply migration 0033 safely: trigger ${object.name} has no recoverable definition`,
        );
      }
      const replacementName = generatedViewsMigrationTriggerName(
        db,
        object.name,
        plannedTriggerNames,
      );
      const sql = renamedTriggerSql(object.sql, replacementName, object.tbl_name, object.name);
      if (sql === null || !executableSchemaDefinition(db, sql)) {
        throw new Error(`Cannot rename legacy trigger ${object.name} safely`);
      }
      collisions.push({
        type: "trigger",
        name: object.name,
        table: object.tbl_name,
        replacementName,
        sql,
        temporary: false,
      });
    }
  }

  return collisions;
}

function recreatedSchemaObjectNameInUse({
  db,
  type,
  temporary,
  name,
}: {
  db: Database;
  type: RecreatedSchemaObjectType;
  temporary: boolean;
  name: string;
}): boolean {
  switch (type) {
    case "trigger":
      return schemaObjectsWithName(db, name).some(
        (candidate) => candidate.temporary === temporary && candidate.object.type === "trigger",
      );
    case "view":
      return migrationObjectNameInUse(db, name);
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function executableIndexedByDependencyDefinition({
  db,
  dependency,
  definition,
}: {
  db: Database;
  dependency: { object: RecreatedSchemaObject; temporary: boolean };
  definition: string;
}): boolean {
  const probeInUse = (name: string) =>
    recreatedSchemaObjectNameInUse({
      db,
      type: dependency.object.type,
      temporary: dependency.temporary,
      name,
    });
  let probeName = `__prb656_${dependency.object.type}_probe`;
  for (let suffix = 2; probeInUse(probeName); suffix += 1) {
    probeName = `__prb656_${dependency.object.type}_probe_${suffix}`;
  }
  let probe: string | null;
  switch (dependency.object.type) {
    case "view":
      probe = renamedSchemaObjectSql({
        type: "view",
        definition,
        name: probeName,
        expectedName: dependency.object.name,
      });
      break;
    case "trigger":
      probe = renamedSchemaObjectSql({
        type: "trigger",
        definition,
        name: probeName,
        expectedTable: dependency.object.tbl_name,
        expectedName: dependency.object.name,
      });
      break;
    default: {
      const _exhaustive: never = dependency.object.type;
      return _exhaustive;
    }
  }
  return probe !== null && executableSchemaDefinition(db, probe);
}

function indexedByDependencyCollisions(
  db: Database,
  collisions: MigrationNameCollision[],
  dependencies?: readonly IndexedByDependency[],
  migrationVersion: 32 | 33 = 33,
): MigrationNameCollision[] {
  const indexedByDependencies =
    dependencies ?? schemaObjectsWithIndexedByDependencies(db, migrationVersion);
  const indexReplacements = new Map(
    collisions
      .filter((collision) => collision.type === "index")
      .map((collision) => [collision.name.toLowerCase(), collision.replacementName]),
  );
  if (indexReplacements.size === 0) return collisions;

  for (const dependency of indexedByDependencies) {
    const replacements = new Map<string, string>();
    for (const indexName of dependency.indexNames) {
      const replacementName = indexReplacements.get(indexName.toLowerCase());
      if (replacementName !== undefined) {
        replacements.set(indexName.toLowerCase(), replacementName);
      }
    }
    if (replacements.size === 0) continue;

    const rewritten = rewriteIndexedBySql(dependency.object.sql ?? "", replacements);
    if (rewritten === null) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: ${dependency.temporary ? "temporary " : ""}` +
          `${dependency.object.type} ${dependency.object.name} has an invalid INDEXED BY dependency`,
      );
    }
    const type = dependency.object.type;
    const executable = dependency.temporary
      ? temporarySchemaDefinition(rewritten, type)
      : rewritten;
    if (
      executable === null ||
      !executableIndexedByDependencyDefinition({ db, dependency, definition: executable })
    ) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: cannot rewrite ${dependency.temporary ? "temporary " : ""}` +
          `${dependency.object.type} ${dependency.object.name} without changing its behavior`,
      );
    }

    const collision = collisions.find(
      (candidate) =>
        candidate.type === dependency.object.type &&
        candidate.temporary === dependency.temporary &&
        candidate.name.toLowerCase() === dependency.object.name.toLowerCase(),
    );
    if (collision !== undefined) {
      const collisionSql = rewriteIndexedBySql(collision.sql, replacements);
      if (collisionSql === null) {
        throw new Error(
          `Cannot apply migration ${migrationVersion} safely: cannot rewrite ${dependency.object.type} ` +
            `${dependency.object.name} after its rename`,
        );
      }
      collision.sql = collisionSql;
      continue;
    }

    collisions.push({
      type,
      name: dependency.object.name,
      table: dependency.object.tbl_name,
      replacementName: dependency.object.name,
      sql: executable,
      temporary: dependency.temporary,
    });
  }

  return collisions;
}

interface MigrationTriggerCaptureOptions {
  migrationLabel: string;
  canonicalContract?: ParsedTriggerDefinition;
}

/**
 * Valida un trigger capturado y prepara su definición para recrearlo sin alterar
 * sus nombres, eventos, predicados ni cuerpo.
 */
function captureMigrationTrigger(
  db: Database,
  definition: TriggerDefinitionRow,
  options: MigrationTriggerCaptureOptions,
): WorkspaceConstraintTriggerSnapshot {
  const canonical = options.canonicalContract !== undefined;
  const migrationLabel = options.migrationLabel;
  if (
    typeof definition.name !== "string" ||
    typeof definition.tbl_name !== "string" ||
    typeof definition.sql !== "string"
  ) {
    const triggerName = typeof definition.name === "string" ? definition.name : "unknown";
    const triggerTable = typeof definition.tbl_name === "string" ? definition.tbl_name : "unknown";
    throw new Error(
      `Cannot apply migration ${migrationLabel} safely: ${canonical ? "canonical" : "custom"} ` +
        `trigger ${triggerName} on ${triggerTable} has no recoverable definition`,
    );
  }
  const triggerName = definition.name;
  const triggerTable = definition.tbl_name;
  const triggerSql = definition.sql;
  const parsed = triggerDefinitionFromSql(triggerSql);
  const recreatedSql =
    parsed === null
      ? null
      : triggerSqlForTable(triggerSql, triggerName, triggerTable, triggerTable);
  const recreated = recreatedSql === null ? null : triggerDefinitionFromSql(recreatedSql);
  const canonicalMatches =
    options.canonicalContract === undefined ||
    (parsed !== null &&
      parsed.name.toLowerCase() === options.canonicalContract.name.toLowerCase() &&
      parsed.table.toLowerCase() === options.canonicalContract.table.toLowerCase() &&
      sameTriggerBehavior(parsed, options.canonicalContract));
  if (!canonicalMatches && canonical) {
    throw new Error(
      `Cannot apply migration ${migrationLabel} safely: canonical trigger ${triggerName} on ` +
        `${triggerTable} is incompatible`,
    );
  }
  const executable =
    canonical || parsed === null || recreatedSql === null
      ? executableTriggerSchemaDefinition(db, triggerSql) &&
        (recreatedSql === null || executableTriggerSchemaDefinition(db, recreatedSql))
      : executableTriggerDefinition(db, triggerSql) &&
        executableTriggerDefinition(db, recreatedSql);
  if (
    parsed === null ||
    parsed.name.toLowerCase() !== triggerName.toLowerCase() ||
    parsed.table.toLowerCase() !== triggerTable.toLowerCase() ||
    recreatedSql === null ||
    recreated === null ||
    recreated.name.toLowerCase() !== triggerName.toLowerCase() ||
    recreated.table.toLowerCase() !== triggerTable.toLowerCase() ||
    !sameTriggerBehavior(parsed, recreated) ||
    !executable
  ) {
    throw new Error(
      `Cannot apply migration ${migrationLabel} safely: ${canonical ? "canonical" : "custom"} ` +
        `trigger ${triggerName} on ${triggerTable} cannot be preserved safely`,
    );
  }

  return {
    name: triggerName,
    table: triggerTable,
    sql: triggerSql,
    recreatedSql,
    canonical,
  };
}

/**
 * Captura triggers MAIN antes de eliminar una tabla Views. Conserva también los
 * canónicos para restaurar el orden de creación; los TEMP se consultan aparte
 * y mantienen la política de PRB-645.
 */
function captureViewsMigrationTriggers(
  db: Database,
  table: string,
  migrationVersion: number,
): ViewsMigrationTriggerSnapshot[] {
  const definitions = db
    .query<TriggerDefinitionRow, SQLQueryBindings[]>(
      "SELECT name, tbl_name, sql FROM sqlite_master " +
        "WHERE type = 'trigger' AND lower(tbl_name) = lower(?1) ORDER BY rowid",
    )
    .all(table);
  const migrationLabel = migrationVersion.toString().padStart(4, "0");

  return definitions.map((definition) => {
    if (
      typeof definition.name !== "string" ||
      typeof definition.tbl_name !== "string" ||
      typeof definition.sql !== "string"
    ) {
      const triggerName = typeof definition.name === "string" ? definition.name : "unknown";
      throw new Error(
        `Cannot apply migration ${migrationLabel} safely: custom trigger ${triggerName} on ${table} ` +
          "has no recoverable definition",
      );
    }
    const triggerName = definition.name;
    const triggerTable = definition.tbl_name;
    const triggerSql = definition.sql;

    const canonical = isViewsMigrationCanonicalTrigger(triggerName);
    const canonicalMatches =
      !canonical ||
      VIEWS_MIGRATION_TRIGGER_CONTRACTS.some(
        (contract) =>
          contract.name.toLowerCase() === triggerName.toLowerCase() &&
          matchesTriggerContract(
            { name: triggerName, tbl_name: triggerTable, sql: triggerSql },
            contract,
          ),
      );
    const parsed = triggerDefinitionFromSql(triggerSql);
    const recreatedSql = triggerSqlForTable(triggerSql, triggerName, triggerTable, table);
    const recreated = recreatedSql === null ? null : triggerDefinitionFromSql(recreatedSql);
    const executable =
      canonical || parsed === null || recreatedSql === null
        ? executableTriggerSchemaDefinition(db, triggerSql) &&
          (recreatedSql === null || executableTriggerSchemaDefinition(db, recreatedSql))
        : executableTriggerDefinition(db, triggerSql) &&
          executableTriggerDefinition(db, recreatedSql);
    if (
      !canonicalMatches ||
      parsed === null ||
      parsed.name.toLowerCase() !== triggerName.toLowerCase() ||
      parsed.table.toLowerCase() !== triggerTable.toLowerCase() ||
      recreatedSql === null ||
      recreated === null ||
      recreated.name.toLowerCase() !== triggerName.toLowerCase() ||
      recreated.table.toLowerCase() !== table.toLowerCase() ||
      !sameTriggerBehavior(parsed, recreated) ||
      !executable
    ) {
      throw new Error(
        `Cannot apply migration ${migrationLabel} safely: ${canonical ? "canonical" : "custom"} ` +
          `trigger ${triggerName} on ${triggerTable} cannot be preserved safely`,
      );
    }

    return {
      name: triggerName,
      table: triggerTable,
      sql: triggerSql,
      recreatedSql,
      canonical,
    };
  });
}

/**
 * Captura los triggers MAIN de todas las tablas que 0025 elimina. Los
 * canónicos solo se validan: el SQL de 0025 los recrea en su orden contractual.
 * Los custom y otros contratos se capturan; un canónico incompatible falla sin DDL.
 */
function captureWorkspaceConstraintTriggers(
  db: Database,
  migrationVersion: number,
): WorkspaceConstraintTriggerSnapshot[] {
  const rebuiltTables = new Set(
    WORKSPACE_CONSTRAINTS_REBUILT_TABLES.map((table) => table.toLowerCase()),
  );
  const definitions = db
    .query<TriggerDefinitionRow, SQLQueryBindings[]>(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY rowid",
    )
    .all();
  const migrationLabel = migrationVersion.toString().padStart(4, "0");
  const snapshots: WorkspaceConstraintTriggerSnapshot[] = [];

  for (const definition of definitions) {
    const triggerName = typeof definition.name === "string" ? definition.name : "unknown";
    const canonicalDefinition =
      typeof definition.name === "string"
        ? WORKSPACE_CONSTRAINTS_CANONICAL_TRIGGER_DEFINITIONS.get(definition.name.toLowerCase())
        : undefined;
    if (canonicalDefinition !== undefined) {
      // 0025 recrea este trigger en el orden canónico de su propio SQL. Solo
      // se valida la definición existente; no se captura ni se vuelve a crear.
      captureMigrationTrigger(db, definition, {
        migrationLabel,
        canonicalContract: canonicalDefinition,
      });
      continue;
    }
    if (
      typeof definition.tbl_name !== "string" ||
      !rebuiltTables.has(definition.tbl_name.toLowerCase())
    ) {
      continue;
    }
    snapshots.push(
      captureMigrationTrigger(db, definition, {
        migrationLabel,
      }),
    );
  }

  return snapshots;
}

const NOTIFICATION_MIGRATION_RESERVED_NAMES = [
  "notification_preferences",
  "idx_notification_preferences_actor_workspace",
] satisfies readonly string[];

function notificationMigrationNameCollisionPlan(db: Database): MigrationNameCollision[] {
  return migrationNameCollisionPlan(db, {
    reservedNames: NOTIFICATION_MIGRATION_RESERVED_NAMES,
    errorPrefix: "Cannot apply migration 0032 safely",
  });
}

function applyMigrationNameCollisions(
  db: Database,
  collisions: readonly MigrationNameCollision[],
): void {
  for (const collision of collisions) {
    const schema = collision.temporary ? "temp." : "";
    if (collision.type === "index") {
      db.exec(`DROP INDEX ${schema}${quoteIdentifier(collision.name)}`);
    } else if (collision.type === "trigger") {
      db.exec(`DROP TRIGGER ${schema}${quoteIdentifier(collision.name)}`);
    } else {
      db.exec(`DROP VIEW ${schema}${quoteIdentifier(collision.name)}`);
    }
    db.exec(collision.sql);
  }
}

function restoreWorkspaceConstraintTriggers(
  db: Database,
  definitions: readonly WorkspaceConstraintTriggerSnapshot[],
): void {
  // Los canónicos de 0025 ya quedaron en el orden declarado por su SQL. Esta
  // captura solo contiene triggers custom u otros contratos instalados fuera de
  // 0025; recrearlos después del DDL conserva su definición sin tocar ese orden.
  for (const definition of definitions) {
    try {
      db.exec(definition.recreatedSql);
    } catch {
      throw new Error(
        `Cannot apply migration 0025 safely: custom trigger ${definition.name} on ` +
          `${definition.table} cannot be preserved safely`,
      );
    }
    if (!executableTriggerDefinition(db, definition.recreatedSql)) {
      throw new Error(
        `Cannot apply migration 0025 safely: custom trigger ${definition.name} on ` +
          `${definition.table} cannot be preserved safely`,
      );
    }
  }
}

function restoreViewsMigrationTriggers(
  db: Database,
  definitions: readonly ViewsMigrationTriggerSnapshot[],
): void {
  for (const definition of definitions) {
    if (definition.canonical && hasTrigger(db, definition.name)) {
      db.exec(`DROP TRIGGER main.${quoteIdentifier(definition.name)}`);
    }
  }
  for (const definition of definitions) {
    db.exec(definition.recreatedSql);
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

function schemaObjectWithTypeAndName({
  db,
  type,
  name,
  temporary,
}: {
  db: Database;
  type: RecreatedSchemaObjectType;
  name: string;
  temporary: boolean;
}): { object: RecreatedSchemaObject; temporary: boolean } | null {
  for (const candidate of schemaObjectsWithName(db, name)) {
    if (
      candidate.temporary === temporary &&
      isRecreatedSchemaObject(candidate.object) &&
      candidate.object.type === type
    ) {
      return { object: candidate.object, temporary: candidate.temporary };
    }
  }
  return null;
}

function findIndexedByDependencyObject(
  db: Database,
  dependency: IndexedByDependency,
  renamedObjects: readonly MigrationNameCollision[],
): { object: RecreatedSchemaObject; temporary: boolean } | null {
  const renamed = renamedObjects.find(
    (collision) =>
      collision.type === dependency.object.type &&
      collision.temporary === dependency.temporary &&
      collision.name.toLowerCase() === dependency.object.name.toLowerCase(),
  );
  if (renamed !== undefined && renamed.replacementName !== dependency.object.name) {
    return schemaObjectWithTypeAndName({
      db,
      type: dependency.object.type,
      name: renamed.replacementName,
      temporary: dependency.temporary,
    });
  }
  return schemaObjectWithTypeAndName({
    db,
    type: dependency.object.type,
    name: dependency.object.name,
    temporary: dependency.temporary,
  });
}

function dropSchemaObject({
  db,
  type,
  name,
  temporary,
}: {
  db: Database;
  type: RecreatedSchemaObjectType;
  name: string;
  temporary: boolean;
}): void {
  const schema = temporary ? "temp." : "";
  switch (type) {
    case "trigger":
      db.exec(`DROP TRIGGER ${schema}${quoteIdentifier(name)}`);
      return;
    case "view":
      db.exec(`DROP VIEW ${schema}${quoteIdentifier(name)}`);
      return;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function applyIndexedByDependencyRewrites(
  db: Database,
  dependencies: readonly IndexedByDependency[],
  replacements: ReadonlyMap<string, string>,
  renamedObjects: readonly MigrationNameCollision[],
  migrationVersion: 32 | 33 = 33,
): void {
  if (replacements.size === 0) return;
  const operations: Array<{
    current: { object: RecreatedSchemaObject; temporary: boolean } | null;
    type: RecreatedSchemaObjectType;
    name: string;
    temporary: boolean;
    sql: string;
  }> = [];

  for (const dependency of dependencies) {
    const dependencyReplacements = new Map<string, string>();
    for (const indexName of dependency.indexNames) {
      const replacementName = replacements.get(indexName.toLowerCase());
      if (replacementName !== undefined) {
        dependencyReplacements.set(indexName.toLowerCase(), replacementName);
      }
    }
    if (dependencyReplacements.size === 0) continue;

    const current = findIndexedByDependencyObject(db, dependency, renamedObjects);
    const renamed = renamedObjects.find(
      (collision) =>
        collision.type === dependency.object.type &&
        collision.temporary === dependency.temporary &&
        collision.name.toLowerCase() === dependency.object.name.toLowerCase(),
    );
    if (current === null && renamed !== undefined && renamed.replacementName !== renamed.name) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: ${dependency.object.type} ${dependency.object.name} ` +
          `was renamed but its dependent definition is unavailable`,
      );
    }

    const object = current?.object ?? dependency.object;
    const definition = object.sql;
    if (definition === null) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: ${dependency.object.type} ${object.name} ` +
          `has no recoverable definition`,
      );
    }
    const rewritten = rewriteIndexedBySql(definition, dependencyReplacements);
    if (rewritten === null) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: cannot rewrite ${dependency.object.type} ` +
          `${object.name} INDEXED BY dependency`,
      );
    }
    if (rewritten === definition) continue;

    const type = object.type;
    const temporary = current?.temporary ?? dependency.temporary;
    const executable = temporary ? temporarySchemaDefinition(rewritten, type) : rewritten;
    const executableDependency = { object, temporary };
    if (
      executable === null ||
      !executableIndexedByDependencyDefinition({
        db,
        dependency: executableDependency,
        definition: executable,
      })
    ) {
      throw new Error(
        `Cannot apply migration ${migrationVersion} safely: cannot recreate ${temporary ? "temporary " : ""}` +
          `${type} ${object.name} after its INDEXED BY rewrite`,
      );
    }
    operations.push({
      current,
      type,
      name: object.name,
      temporary,
      sql: executable,
    });
  }

  for (const operation of operations) {
    if (operation.current !== null) {
      dropSchemaObject({
        db,
        type: operation.type,
        name: operation.name,
        temporary: operation.temporary,
      });
    }
    db.exec(operation.sql);
  }
}

interface RestoreSavedViewsIndexesOptions {
  db: Database;
  definitions: readonly SavedViewsIndexDefinition[];
  dependencies?: readonly IndexedByDependency[];
  renamedObjects?: readonly MigrationNameCollision[];
  previousReplacements?: ReadonlyMap<string, string>;
  migrationVersion?: 32 | 33;
}

function restoreSavedViewsIndexes({
  db,
  definitions,
  dependencies = [],
  renamedObjects = [],
  previousReplacements = new Map(),
  migrationVersion = 33,
}: RestoreSavedViewsIndexesOptions): void {
  const replacements = new Map(previousReplacements);
  for (const definition of definitions) {
    // Las constraints de tabla llegan con sql=NULL y origin u/pk. Si la tabla
    // canónica ya provee ese índice, se conserva su contrato; las demás se
    // materializan como índices explícitos con columnas de PRAGMA.

    const unique = definition.unique_value === 1;
    const predicate =
      definition.partial === 0
        ? undefined
        : indexPredicateTokensFromDefinition(definition.sql ?? "");
    if (definition.partial !== 0 && predicate === null) {
      throw new Error(`Cannot restore saved_views index ${definition.name} safely`);
    }
    const equivalentName = equivalentIndexName(
      db,
      "saved_views",
      definition.terms,
      unique,
      undefined,
      definition.partial,
      predicate ?? undefined,
    );
    if (equivalentName !== null) {
      if (definition.name.toLowerCase() !== equivalentName.toLowerCase()) {
        replacements.set(definition.name.toLowerCase(), equivalentName);
      }
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
      if (definition.name.toLowerCase() !== indexName.toLowerCase()) {
        replacements.set(definition.name.toLowerCase(), indexName);
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
    if (definition.name.toLowerCase() !== indexName.toLowerCase()) {
      replacements.set(definition.name.toLowerCase(), indexName);
    }
    db.exec(
      `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(indexName)} ON saved_views(${terms})`,
    );
  }
  applyIndexedByDependencyRewrites(
    db,
    dependencies,
    replacements,
    renamedObjects,
    migrationVersion,
  );
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
      sameSqliteIdentifier(row.table, expected.table) &&
      sameSqliteIdentifier(row.from, expectedColumn.from) &&
      sameSqliteIdentifier(row.to, expectedColumn.to) &&
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
  if (value === null) return null;
  const tokens = sqliteTokens(value);
  // Los tokens quitan espacios de la sintaxis, pero conservan el texto de los literales.
  return tokens === null ? value : comparableSqlTokens(tokens).join("\u001f");
}

function tableSql(db: Database, table: string): string | null {
  return (
    db
      .query<SqlDefinitionRow, SQLQueryBindings[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1 COLLATE NOCASE",
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
    const expectedNames = new Set(expected.map((column) => normalizeSqliteIdentifier(column.name)));
    const unexpected = actual
      .filter((column) => !expectedNames.has(normalizeSqliteIdentifier(column.name)))
      .map((column) => column.name);
    if (unexpected.length > 0)
      problems.push(`${table} has unexpected columns: ${unexpected.join(", ")}`);
    if (actual.length < expected.length) {
      const actualNames = new Set(actual.map((column) => normalizeSqliteIdentifier(column.name)));
      const missing = expected
        .filter((column) => !actualNames.has(normalizeSqliteIdentifier(column.name)))
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
    if (!sameSqliteIdentifier(column.name, contract.name)) {
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
  const triggerSchemaProblems = viewsMigrationTriggerPrerequisiteProblems(
    db,
    VIEWS_MIGRATION_TRIGGER_CONTRACTS,
  );
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
    ...triggerSchemaProblems,
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

/**
 * Valida la identidad y las operaciones ejecutables del trigger. No usa una
 * coincidencia textual: comentarios se descartan y literales permanecen como
 * un token, por lo que ninguno puede satisfacer el contrato por accidente.
 */
function triggerProblems(db: Database, expected: readonly TriggerContract[]): string[] {
  return expected.flatMap((contract) => {
    const definition =
      db
        .query<TriggerDefinitionRow, SQLQueryBindings[]>(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1 COLLATE NOCASE",
        )
        .get(contract.name) ?? null;
    return matchesTriggerContract(definition, contract)
      ? []
      : [`missing or incompatible trigger ${contract.name}`];
  });
}

function viewsMigrationTriggerPrerequisiteProblems(
  db: Database,
  expected: readonly TriggerContract[],
): string[] {
  return expected.flatMap((contract) => {
    const definitions = db
      .query<TriggerDefinitionRow, SQLQueryBindings[]>(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1 COLLATE NOCASE",
      )
      .all(contract.name);
    const sameTable =
      definitions.find(
        (definition) =>
          typeof definition.tbl_name === "string" &&
          sameSqliteIdentifier(definition.tbl_name, contract.table),
      ) ?? null;
    if (sameTable !== null) {
      return matchesTriggerContract(sameTable, contract)
        ? []
        : [`missing or incompatible trigger ${contract.name}`];
    }
    const crossTable = definitions[0];
    if (
      crossTable !== undefined &&
      typeof crossTable.name === "string" &&
      typeof crossTable.tbl_name === "string" &&
      typeof crossTable.sql === "string" &&
      renamedTriggerSql(
        crossTable.sql,
        `${contract.name}_legacy`,
        crossTable.tbl_name,
        crossTable.name,
      ) !== null
    ) {
      return [];
    }
    return [`missing or incompatible trigger ${contract.name}`];
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
  problems.push(...triggerProblems(db, VIEWS_MIGRATION_TRIGGER_CONTRACTS));

  return problems;
}

function hasAllColumns(db: Database, table: string, columns: readonly string[]): boolean {
  if (!hasTable(db, table)) return false;
  const actual = new Set(
    tableInfo(db, table).map((column) => normalizeSqliteIdentifier(column.name)),
  );
  return columns.every((column) => actual.has(normalizeSqliteIdentifier(column)));
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
  const indexedByDependencies = schemaObjectsWithIndexedByDependencies(db, 33);
  const nameCollisionPlan = indexedByDependencyCollisions(
    db,
    [...viewsMigrationNameCollisionPlan(db, false), ...notificationMigrationNameCollisionPlan(db)],
    indexedByDependencies,
    33,
  );

  db.transaction(() => {
    const appliedAt = now();
    applyMigrationNameCollisions(db, nameCollisionPlan);
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
    if (migration.version === 25) {
      // PRB-654 mantiene la protección de saved_views; PRB-659 extiende el
      // mismo fail-closed a cada tabla no-Views que 0025 reconstruye.
      validateTemporaryTriggerBeforeRebuild(db, "saved_views", migration.version);
      validateWorkspaceConstraintTemporaryTriggers(db, migration.version);
    }
    if (migration.version === 33) validateViewsMigrationPrerequisites(db);
    const indexedByDependencies =
      migration.version === 32 || migration.version === 33
        ? schemaObjectsWithIndexedByDependencies(db, migration.version)
        : [];
    // PRB-472 y PRB-390 reconstruyen el grafo de tablas para reemplazar FKs
    // simples por FKs compuestas. SQLite no permite cambiar foreign_keys dentro
    // de una transacción activa. El runner desactiva las comprobaciones solo
    // alrededor de estas migraciones y las reactiva aun si una falla.
    const rebuild = migration.version === 25 || migration.version === 33;
    const savedViewIndexes = migration.version === 33 ? savedViewsIndexDefinitions(db) : [];
    const nameCollisionPlan =
      migration.version === 33
        ? indexedByDependencyCollisions(
            db,
            viewsMigrationNameCollisionPlan(db, true),
            indexedByDependencies,
            33,
          )
        : [];
    const notificationNameCollisionPlan =
      migration.version === 32
        ? indexedByDependencyCollisions(
            db,
            notificationMigrationNameCollisionPlan(db),
            indexedByDependencies,
            32,
          )
        : [];
    const previousIndexReplacements = new Map(
      nameCollisionPlan
        .filter((collision) => collision.type === "index")
        .map((collision) => [collision.name.toLowerCase(), collision.replacementName]),
    );
    const savedViewsTriggerSnapshots =
      migration.version === 25 || migration.version === 33
        ? captureViewsMigrationTriggers(db, "saved_views", migration.version)
        : [];
    const workspaceConstraintTriggerSnapshots =
      migration.version === 25 ? captureWorkspaceConstraintTriggers(db, migration.version) : [];
    if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        if (migration.version === 24) validateWorkspaceMigration(db, "before");
        if (migration.version === 26) validateApiKeyWorkspaceMigration(db, "before");
        if (migration.version === 30) verifyDocumentsBeforeRetirement(db, options);
        if (migration.version === 32) {
          applyMigrationNameCollisions(db, notificationNameCollisionPlan);
        }
        if (migration.version === 33) applyMigrationNameCollisions(db, nameCollisionPlan);
        db.exec(migration.sql);
        if (migration.version === 33) {
          restoreSavedViewsIndexes({
            db,
            definitions: savedViewIndexes,
            dependencies: indexedByDependencies,
            renamedObjects: nameCollisionPlan,
            previousReplacements: previousIndexReplacements,
          });
        }
        if (savedViewsTriggerSnapshots.length > 0) {
          restoreViewsMigrationTriggers(db, savedViewsTriggerSnapshots);
        }
        if (workspaceConstraintTriggerSnapshots.length > 0) {
          restoreWorkspaceConstraintTriggers(db, workspaceConstraintTriggerSnapshots);
        }
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
