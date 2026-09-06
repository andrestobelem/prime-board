import type { Database } from "bun:sqlite";

/** Resultado de una consulta SQLite sin confiar en el casing de las columnas. */
export type SQLiteResultRow = Record<string, unknown>;

export type SQLiteColumnMetadata =
  | { readonly kind: "available"; readonly names: readonly string[] }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "invalid" };

export type SQLiteColumnLookup =
  | { readonly kind: "found"; readonly name: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "invalid" };

/**
 * Aplica el mismo case folding a los nombres físicos y canónicos.
 * `toLowerCase()` también conserva colisiones Unicode como `İD`/`i̇d`.
 */
export function foldSqliteIdentifier(identifier: string): string {
  return identifier.toLowerCase();
}

/**
 * Normaliza las claves de una fila SQLite a lowercase sin cambiar sus valores.
 * Una colisión case-folded invalida la fila para evitar elegir una columna de
 * forma arbitraria.
 */
export function normalizeSqliteResultRow(value: unknown): SQLiteResultRow | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized: SQLiteResultRow = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = foldSqliteIdentifier(key);
    if (Object.prototype.hasOwnProperty.call(normalized, normalizedKey)) return undefined;
    normalized[normalizedKey] = item;
  }
  return normalized;
}

/**
 * Cita un identificador SQLite sin interpolar comillas de una fuente externa.
 */
export function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

/**
 * Lee los nombres físicos de columnas y expone la ambigüedad del esquema. SQLite no
 * distingue mayúsculas ASCII en identificadores, y el importador tampoco debe
 * elegir una columna arbitraria cuando el driver devuelve nombres colisionados.
 */
export function sqliteColumnNames(db: Database, physicalTableName: string): SQLiteColumnMetadata {
  const names: string[] = [];
  const foldedNames = new Set<string>();
  for (const value of db
    .query(`PRAGMA table_info(${quoteSqliteIdentifier(physicalTableName)})`)
    .all() as unknown[]) {
    const row = normalizeSqliteResultRow(value);
    if (typeof row?.name !== "string") return { kind: "invalid" };
    const foldedName = foldSqliteIdentifier(row.name);
    if (foldedNames.has(foldedName)) return { kind: "ambiguous" };
    foldedNames.add(foldedName);
    names.push(row.name);
  }
  return { kind: "available", names };
}

/** Devuelve una columna física solo si el esquema no contiene colisiones. */
export function sqliteColumnName(
  db: Database,
  physicalTableName: string,
  canonicalName: string,
): SQLiteColumnLookup {
  const metadata = sqliteColumnNames(db, physicalTableName);
  if (metadata.kind === "ambiguous" || metadata.kind === "invalid") return metadata;
  const foldedCanonicalName = foldSqliteIdentifier(canonicalName);
  const name = metadata.names.find(
    (candidate) => foldSqliteIdentifier(candidate) === foldedCanonicalName,
  );
  return name === undefined ? { kind: "missing" } : { kind: "found", name };
}
