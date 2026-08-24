# ADR-0018: Contrato async de persistencia

- **Estado:** aceptado
- **Fecha:** 2026-08-19
- **Contexto:** PRB-423

## Contexto

El server usa `bun:sqlite` de forma síncrona en parte del dominio, GraphQL, scripts y tests. PostgreSQL es un backend opcional y tiene I/O de red y conexiones dedicadas. Por eso los módulos de negocio no deben propagar tipos del driver ni mantener callbacks síncronos. El contrato async permite migrar los dominios por etapas sin cambiar sus interfaces públicas.

## Decisión

El contrato `Persistence` vive en `apps/server/src/db/persistence.ts` y define estas operaciones:

- `one<T>()` devuelve una fila o `null`.
- `many<T>()` siempre devuelve una lista, incluso cuando está vacía.
- `execute<T>()` devuelve `rows` para consultas con `RETURNING`, `rowCount` para filas afectadas y, cuando existe, `lastInsertId`.
- `transaction<T>(async tx => ...)` abre una transacción y entrega a la callback un `PersistenceTransaction` sin acceso al driver. Si la callback falla, el adaptador hace rollback y propaga el error. El adaptador SQLite rechaza transacciones anidadas.
- `close()` es async e idempotente.

Los callers pasan los parámetros separados del SQL. Las sentencias del contrato usan placeholders posicionales `$1`, `$2`, etc. El contrato no acepta SQL compuesto de migraciones: cada driver mantiene su helper para bootstrap y migraciones. Los errores del driver se convierten en `PersistenceError` sin SQL ni valores parametrizados en el mensaje. Los errores del dominio dentro de una transacción se propagan después del rollback.

## Implementación actual

`createSqlitePersistence()` en `db/sqlite-persistence.ts` adapta la conexión SQLite existente. Envuelve sus operaciones síncronas en Promises y usa `BEGIN`/`COMMIT`/`ROLLBACK` explícitos para ejecutar el callback de la transacción con el contrato async.

`createPostgresPersistence()` en `db/postgres/persistence.ts` adapta `Bun.SQL`. Usa parámetros separados, normaliza filas afectadas y resultados `RETURNING`, convierte los errores del driver en `PersistenceError` y ejecuta `transaction()` con `sql.begin()`. `close()` es async e idempotente en ambos adaptadores.

`resolvePersistenceBackend()` y `openPersistence()` en `db/backend.ts` seleccionan SQLite por defecto o PostgreSQL cuando la configuración lo solicita. PostgreSQL exige una URL explícita. El arranque del server aplica las migraciones PG antes de crear el adaptador y conserva un SQLite en memoria para los dominios que todavía no tienen una ruta PostgreSQL.

Este contrato no implica un cutover completo. PostgreSQL mantiene una Workspace singleton y su cobertura es incremental. Los resolvers migrados usan `context.persistence` para Actors, autenticación, API keys y límites de Team, Teams, Issues, Relations, Projects, Milestones, Cycles, Labels, Documents, Activity, suscriptores, Reviews, Initiatives, Project Updates, Saved Views, Favorites, Inbox y Webhooks. Relations tiene lectura y mutaciones PostgreSQL desde PRB-437. API keys y límites de Team usan PostgreSQL desde PRB-552 mediante las migraciones `0008` y `0009`. Comments no tiene una ruta PostgreSQL. El event log canónico y el proyector Repository Source → PostgreSQL no forman parte de este runtime; ADR-0019 los deja para PRB-445/453.

## Consecuencias

- El dominio puede probarse contra una implementación async sin importar `bun:sqlite` ni `Bun.SQL`.
- La adaptación habilita PostgreSQL para los dominios migrados, pero no declara un cutover ni una paridad completa con SQLite.
- Mientras SQLite sea el backend, una conexión no debe ejecutar transacciones concurrentes ni anidadas. Los callers deben esperar cada transacción.
