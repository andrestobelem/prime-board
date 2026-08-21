# Lectura de issues en PostgreSQL

- **Tickets:** PRB-434, PRB-435, PRB-436
- **Implementación:** `apps/server/src/domain/postgres-issues.ts`, `apps/server/src/domain/filters.ts`

## Alcance

Con `PRIME_BOARD_PERSISTENCE=postgres`, las queries GraphQL `issue` e `issues` leen directamente de PostgreSQL. El adaptador conserva la forma de los nodos, los Identifiers `TEAM-123`, el orden estable, los límites de página y los cursores. `children` también consulta PostgreSQL y aplica la visibilidad del Team y los límites de la API key.

El adaptador intersecta el filtro solicitado con los Teams que el viewer puede descubrir. Trata los Teams privados no accesibles como recursos ausentes e incluye las Issues archivadas solo con `includeArchived: true`.

## Compatibilidad y límites explícitos

El adaptador reutiliza el generador de filtros después de traducir sus parámetros posicionales a `$1`, `$2`, etc. El predicado full-text usa el índice `search_vector` de PostgreSQL, tokens simples con prefijos, frases exactas, normalización de mayúsculas y acentos y parámetros bind. La migración `0004` reconstruye el vector de las filas existentes. El adaptador no consulta SQLite en silencio. Los campos anidados de Labels, Projects, Milestones, Cycles, Comments, Relations y Activity mantienen el mismo límite explícito hasta que migren sus dominios.

Las mutaciones core `issueCreate`, `issueUpdate` e `issueArchive` también usan transacciones PostgreSQL. La numeración automática toma un lock lógico sobre el Team y confirma o revierte juntos los cambios de la Issue y su Activity. Projects, Labels, Milestones, Cycles y Relations siguen fallando explícitamente hasta que migren.

La validación reproducible vive en `scripts/validate-postgres-actors.ts`. Incluye creación, actualización, archivado, lectura directa por Identifier, paginación, children, visibilidad privada y búsquedas por prefijo, frase, acento y entrada inválida.
