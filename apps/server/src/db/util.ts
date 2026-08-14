// Utilidades compartidas de la capa de datos.

/** UUID v7: ordenable por tiempo, ideal como PK en SQLite. */
export function newId(): string {
  return Bun.randomUUIDv7();
}

/** Timestamp ISO-8601 UTC. */
export function now(): string {
  return new Date().toISOString();
}
