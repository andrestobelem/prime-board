# ADR-0018: Contrato async de persistencia

- **Estado:** Aceptado
- **Fecha:** 2026-08-19
- **Contexto:** PRB-423

## Contexto

El servidor usa `bun:sqlite` de forma síncrona en el dominio, GraphQL, scripts y
pruebas. La futura migración a PostgreSQL tendrá I/O de red y conexiones dedicadas,
por lo que no conviene propagar tipos del driver ni mantener callbacks síncronos en
los módulos de negocio.

## Decisión

Se define `Persistence` en `apps/server/src/db/persistence.ts` con estas operaciones:

- `one<T>()` devuelve una fila o `null`.
- `many<T>()` devuelve siempre una lista (incluida una lista vacía).
- `execute<T>()` devuelve `rows` para consultas con `RETURNING`, `rowCount` para filas
  afectadas y, cuando existe, `lastInsertId`.
- `transaction<T>(async tx => ...)` abre una transacción y expone a la callback un
  `PersistenceTransaction` sin acceso al driver. Un fallo de la callback hace rollback
  y propaga el error; el adaptador SQLite rechaza transacciones anidadas.
- `close()` es async e idempotente.

Los parámetros se pasan separadamente del SQL y las sentencias del contrato usan
placeholders posicionales `$1`, `$2`, etc. El contrato no acepta SQL compuesto de
migraciones: cada driver mantiene su helper específico para bootstrap y migraciones.
Los errores del driver se convierten en `PersistenceError` sin incluir SQL ni valores
parametrizados en el mensaje; los errores del dominio dentro de una transacción se
propagan después del rollback.

## Implementación actual

`createSqlitePersistence()` de `db/sqlite-persistence.ts` adapta la conexión SQLite existente envolviendo sus
operaciones síncronas en Promises y usando `BEGIN`/`COMMIT`/`ROLLBACK` explícitos para
poder esperar callbacks async. `openPersistence()` en `db/backend.ts` selecciona este
adaptador por defecto y deja PostgreSQL como backend reservado, fallando explícitamente
hasta que exista su implementación. Los módulos actuales siguen usando la API
síncrona; la migración incremental de dominios a este seam queda para los tickets
posteriores. El adaptador PostgreSQL deberá reservar una conexión dedicada por
transacción y normalizar su `rowCount`/`RETURNING` al mismo resultado.

## Consecuencias

- El dominio futuro puede probarse contra una implementación async sin importar
  `bun:sqlite` ni `Bun.SQL`.
- La adaptación no cambia todavía el comportamiento de producción ni habilita
  PostgreSQL.
- Mientras SQLite sea el backend, una conexión no debe ejecutar transacciones
  concurrentes ni anidadas; los callers deben esperar cada transacción.
