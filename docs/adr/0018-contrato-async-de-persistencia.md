# ADR-0018: Contrato async de persistencia

- **Estado:** aceptado
- **Fecha:** 2026-08-19
- **Contexto:** PRB-423

## Contexto

El server usa `bun:sqlite` de forma síncrona en el dominio, GraphQL, scripts y tests. La futura migración a PostgreSQL tendrá I/O de red y conexiones dedicadas. Por eso los módulos de negocio no deben propagar tipos del driver ni mantener callbacks síncronos.

## Decisión

El contrato `Persistence` vive en `apps/server/src/db/persistence.ts` y define estas operaciones:

- `one<T>()` devuelve una fila o `null`.
- `many<T>()` siempre devuelve una lista, incluso cuando está vacía.
- `execute<T>()` devuelve `rows` para consultas con `RETURNING`, `rowCount` para filas afectadas y, cuando existe, `lastInsertId`.
- `transaction<T>(async tx => ...)` abre una transacción y entrega a la callback un `PersistenceTransaction` sin acceso al driver. Si la callback falla, el adaptador hace rollback y propaga el error. El adaptador SQLite rechaza transacciones anidadas.
- `close()` es async e idempotente.

Los callers pasan los parámetros separados del SQL. Las sentencias del contrato usan placeholders posicionales `$1`, `$2`, etc. El contrato no acepta SQL compuesto de migraciones: cada driver mantiene su helper para bootstrap y migraciones. Los errores del driver se convierten en `PersistenceError` sin SQL ni valores parametrizados en el mensaje. Los errores del dominio dentro de una transacción se propagan después del rollback.

## Implementación actual

`createSqlitePersistence()` en `db/sqlite-persistence.ts` adapta la conexión SQLite existente. Envuelve sus operaciones síncronas en Promises y usa `BEGIN`/`COMMIT`/`ROLLBACK` explícitos para esperar callbacks async. `openPersistence()` en `db/backend.ts` selecciona este adaptador por defecto y deja PostgreSQL como backend reservado. Falla explícitamente hasta que exista su implementación.

Los módulos actuales todavía usan la API síncrona. Los tickets posteriores harán la migración incremental de los dominios a este seam. El adaptador PostgreSQL deberá reservar una conexión dedicada por transacción y normalizar `rowCount`/`RETURNING` al mismo resultado.

## Consecuencias

- El dominio futuro puede probarse contra una implementación async sin importar `bun:sqlite` ni `Bun.SQL`.
- La adaptación todavía no cambia el comportamiento de producción ni habilita PostgreSQL.
- Mientras SQLite sea el backend, una conexión no debe ejecutar transacciones concurrentes ni anidadas. Los callers deben esperar cada transacción.
