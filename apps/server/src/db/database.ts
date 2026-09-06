// Apertura de la base SQLite (WAL) y corrida de migraciones versionadas.
import { Database } from "bun:sqlite";
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

const SAVED_VIEWS_REQUIRED_FOREIGN_KEYS = [
  { table: "actors", from: "owner_id", to: "id", onDelete: "NO ACTION" },
  { table: "workspace", from: "workspace_id", to: "id", onDelete: "CASCADE" },
  { table: "teams", from: "workspace_id", to: "workspace_id", onDelete: "NO ACTION" },
  { table: "teams", from: "team_id", to: "id", onDelete: "NO ACTION" },
];

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

function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
  );
}

function hasIndexWithColumns(
  db: Database,
  table: string,
  columns: string[],
  unique: boolean,
): boolean {
  const columnJoins = columns
    .map(
      (_, position) => `
        JOIN pragma_index_info(indexes.name) AS index_column_${position}
          ON index_column_${position}.seqno = ${position}
         AND index_column_${position}.name = ?${position + 3}`,
    )
    .join("\n");
  const result = db
    .query(
      `SELECT 1
       FROM pragma_index_list('${table}') AS indexes
       ${columnJoins}
       WHERE indexes."unique" = ?1
         AND NOT EXISTS (
           SELECT 1 FROM pragma_index_info(indexes.name) WHERE seqno >= ?2
         )
       LIMIT 1`,
    )
    .get(unique ? 1 : 0, columns.length, ...columns);
  return Boolean(result);
}

function hasSavedViewsForeignKey(
  db: Database,
  foreignKey: { table: string; from: string; to: string; onDelete: string },
): boolean {
  return Boolean(
    db
      .query(
        `SELECT 1
         FROM pragma_foreign_key_list('saved_views')
         WHERE "table" = ?1
           AND "from" = ?2
           AND "to" = ?3
           AND on_delete = ?4
         LIMIT 1`,
      )
      .get(foreignKey.table, foreignKey.from, foreignKey.to, foreignKey.onDelete),
  );
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
    (column) =>
      !db.query("SELECT 1 FROM pragma_table_info('saved_views') WHERE name = ?1").get(column),
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

  const missingForeignKeys = SAVED_VIEWS_REQUIRED_FOREIGN_KEYS.filter(
    (foreignKey) => !hasSavedViewsForeignKey(db, foreignKey),
  );
  const missingIndexes = VIEWS_MIGRATION_REQUIRED_INDEXES.filter(
    (index) => !hasIndexWithColumns(db, index.table, index.columns, index.unique),
  );
  const missingPrimaryKey = !db
    .query("SELECT 1 FROM pragma_table_info('saved_views') WHERE name = 'id' AND pk = 1")
    .get();
  const invalidRows = invalidSavedViewRows(db);
  const problems = [
    ...(missingPrimaryKey ? ["saved_views.id is not a primary key"] : []),
    ...(missingForeignKeys.length > 0
      ? [
          `missing foreign keys: ${missingForeignKeys
            .map((foreignKey) => `${foreignKey.from} -> ${foreignKey.table}.${foreignKey.to}`)
            .join(", ")}`,
        ]
      : []),
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
  ];
  if (problems.length > 0) {
    throw new Error(
      `Cannot apply migration 0033 (views_preferences): saved_views has an incompatible ` +
        `schema or data (${problems.join("; ")}). Restore a compatible saved_views schema ` +
        "and data or rebuild the database, then retry.",
    );
  }
}

function validateViewsMigrationResult(db: Database): void {
  try {
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
    if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        if (migration.version === 24) validateWorkspaceMigration(db, "before");
        if (migration.version === 26) validateApiKeyWorkspaceMigration(db, "before");
        if (migration.version === 30) verifyDocumentsBeforeRetirement(db, options);
        db.exec(migration.sql);
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
