import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/database.ts";
import type { Persistence, SqlValue } from "../db/persistence.ts";
import { exportBoard, type ExportOptions, type ExportResult } from "./exporter.ts";
import { archiveDocumentRows } from "./documents-archive.ts";

const TABLES = [
  "workspace",
  "actors",
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
  "webhooks",
  "api_keys",
  "api_key_scopes",
  "api_key_team_limits",
  "saved_views",
  "favorites",
  "team_memberships",
  "project_updates",
  "reviews",
  "initiatives",
  "initiative_projects",
  "initiative_teams",
  "inbox_receipts",
  "issue_subscribers",
] as const;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function archiveRetiredPostgresDocuments(
  persistence: Persistence,
  archivePath: string | undefined,
): Promise<void> {
  // Query information_schema instead of selecting the table directly. This
  // keeps exports compatible with databases that already ran the retirement
  // migration, where `documents` no longer exists.
  const columns = await persistence.many<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY ordinal_position`,
    ["documents"],
  );
  if (!columns.length) return;
  const rows = await persistence.many<Record<string, unknown>>(
    'SELECT * FROM "documents" ORDER BY "id"',
  );
  if (!rows.length) return;
  const trimmed = archivePath?.trim();
  if (!trimmed) {
    throw new Error(
      "Cannot export PostgreSQL Documents with data: provide PRIME_BOARD_DOCUMENTS_ARCHIVE after running archive-documents",
    );
  }
  archiveDocumentRows(rows, trimmed, "postgres");
}

async function copyTable(persistence: Persistence, db: Database, table: string): Promise<void> {
  const sqliteColumns = (
    db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
  if (!sqliteColumns.length) return;
  const postgresColumns = await persistence.many<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  const columns = postgresColumns
    .map((column) => column.column_name)
    .filter((column) => sqliteColumns.includes(column));
  if (!columns.length) return;
  const selected = columns.map(quoteIdentifier).join(", ");
  const rows = await persistence.many<Record<string, unknown>>(
    `SELECT ${selected} FROM ${quoteIdentifier(table)}`,
  );
  if (!rows.length) return;
  const placeholders = columns.map(() => "?").join(", ");
  const insert = db.query(
    `INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${selected}) VALUES (${placeholders})`,
  );
  const before = Number(
    (db.query(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number })
      .count,
  );
  for (const row of rows) {
    const values: SqlValue[] = columns.map((column) => {
      const value = row[column];
      if (value === null || value === undefined) return null;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "bigint" ||
        typeof value === "boolean"
      )
        return value;
      return JSON.stringify(value);
    });
    insert.run(...(values as never[]));
  }
  const after = Number(
    (db.query(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number })
      .count,
  );
  if (after - before !== rows.length) {
    throw new Error(`PostgreSQL export lost rows while projecting table ${table}`);
  }
}

/**
 * Exporta PostgreSQL mediante el exportador determinista existente.
 * La base SQLite temporal es solo una proyección de exportación. PostgreSQL
 * permanece como fuente de verdad y la copia no escribe en el repositorio.
 */
export async function exportPostgresBoard(
  persistence: Persistence,
  rootDir: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  await archiveRetiredPostgresDocuments(
    persistence,
    options.documentsArchivePath ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE,
  );
  const db = openDatabase(":memory:");
  try {
    // Teams y workflow_states se referencian mediante default_state_id.
    // Difiere la validación de FKs hasta completar la proyección.
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      for (const table of TABLES) await copyTable(persistence, db, table);
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length) {
      throw new Error("PostgreSQL export produced invalid foreign-key references");
    }
    return exportBoard(db, rootDir, options);
  } finally {
    db.close();
  }
}
