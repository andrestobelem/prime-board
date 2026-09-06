import type { Database } from "bun:sqlite";

/** Resultado de una consulta SQLite sin confiar en el casing de las columnas. */
export type SQLiteResultRow = Record<string, unknown>;

/**
 * Normaliza las claves de una fila SQLite a lowercase sin cambiar sus valores.
 * Una colisión case-folded invalida la fila para evitar elegir una columna de
 * forma arbitraria.
 */
export function normalizeSqliteResultRow(value: unknown): SQLiteResultRow | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized: SQLiteResultRow = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
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
 * Lee los nombres físicos de columnas y rechaza metadatos ambiguos. SQLite no
 * distingue mayúsculas ASCII en identificadores, y el importador tampoco debe
 * elegir una columna arbitraria cuando el driver devuelve nombres colisionados.
 */
export function sqliteColumnNames(
  db: Database,
  physicalTableName: string,
): readonly string[] | undefined {
  const names: string[] = [];
  const foldedNames = new Set<string>();
  for (const value of db
    .query(`PRAGMA table_info(${quoteSqliteIdentifier(physicalTableName)})`)
    .all() as unknown[]) {
    const row = normalizeSqliteResultRow(value);
    if (typeof row?.name !== "string") return undefined;
    const foldedName = row.name.toLowerCase();
    if (foldedNames.has(foldedName)) return undefined;
    foldedNames.add(foldedName);
    names.push(row.name);
  }
  return names;
}

/** Devuelve una columna física solo si el esquema no contiene colisiones. */
export function sqliteColumnName(
  db: Database,
  physicalTableName: string,
  canonicalName: string,
): string | undefined {
  const names = sqliteColumnNames(db, physicalTableName);
  if (names === undefined) return undefined;
  const foldedCanonicalName = canonicalName.toLowerCase();
  return names.find((name) => name.toLowerCase() === foldedCanonicalName);
}
