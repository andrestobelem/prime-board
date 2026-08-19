# Lectura de issues en PostgreSQL

- **Ticket:** PRB-434
- **Implementación:** `apps/server/src/domain/postgres-issues.ts`

## Alcance

En modo `PRIME_BOARD_PERSISTENCE=postgres`, las consultas GraphQL `issue` e
`issues` leen directamente de PostgreSQL. Se conserva la forma de los nodos,
los identificadores `TEAM-123`, el orden estable, los límites de página y los
cursores. `children` también consulta PostgreSQL y aplica la visibilidad del
Team y el límite de Teams de la API key.

La consulta intersecta el filtro solicitado con los Teams descubribles por el
viewer. Los Teams privados no accesibles se comportan como recursos ausentes,
y los issues archivados se incluyen únicamente con `includeArchived: true`.

## Compatibilidad y límites explícitos

El generador de filtros existente se reutiliza después de traducir sus
parámetros posicionales a `$1`, `$2`, etc. La búsqueda full-text todavía no
está migrada al dialecto PostgreSQL y devuelve `VALIDATION_FAILED`; tampoco se
consulta silenciosamente SQLite. Los campos anidados de labels, projects,
milestones, cycles, comments, relations y activity mantienen el mismo límite
explícito hasta que sus dominios sean migrados.

La validación reproducible está en `scripts/validate-postgres-actors.ts` e
incluye lectura directa por identificador, paginación, children, archivado y
rechazo de full-text no migrado.
