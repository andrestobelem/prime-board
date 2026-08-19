# Lectura de issues en PostgreSQL

- **Tickets:** PRB-434, PRB-435
- **Implementación:** `apps/server/src/domain/postgres-issues.ts`, `apps/server/src/domain/filters.ts`

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
parámetros posicionales a `$1`, `$2`, etc. El predicado full-text usa el índice
`search_vector` de PostgreSQL, tokens simples con prefijos, frases exactas,
normalización de mayúsculas/acentos y parámetros bind; la migración `0004`
reconstruye el vector de filas existentes. Tampoco se consulta silenciosamente
SQLite. Los campos anidados de labels, projects, milestones, cycles, comments,
relations y activity mantienen el mismo límite explícito hasta que sus dominios
sean migrados.

La validación reproducible está en `scripts/validate-postgres-actors.ts` e
incluye lectura directa por identificador, paginación, children, archivado,
visibilidad privada y búsquedas por prefijo, frase, acento y entrada inválida.
