# Migrator PostgreSQL de prime-board

- **Ticket:** PRB-428
- **Implementación:** `apps/server/src/db/postgres/migrator.ts`

## Contrato operativo

`migratePostgres(sql, migrations, lockKey, options)` ordena y valida el registro de migraciones, abre una transacción, toma `pg_advisory_xact_lock` con la clave de la instalación y crea `schema_migrations` si todavía no existe. Cada fila conserva `version`, `name`, el SHA-256 del SQL y `applied_at`.

El runner ejecuta el baseline PostgreSQL como migración `0001/baseline`. `0002/workspace_singleton` garantiza la fila única. `0005` conserva el esquema histórico de Documents y `0011` lo retira después de verificar un archivo externo. `0016` agrega `projector_events`, que registra un receipt por evento aplicado. Las versiones `0012`–`0015` quedan reservadas para otras cadenas de migración. Los SQL futuros deben vivir bajo el namespace PostgreSQL y nunca reutilizar archivos SQLite. El runner usa `unsafe(...).simple()` solo para SQL versionado y controlado por el repositorio, nunca para entrada de usuario.

## Seguridad de arranque

- Dos procesos con la misma `lockKey` esperan el mismo advisory transaction lock. Solo uno puede insertar y aplicar una versión; el segundo vuelve a consultar la tabla dentro de su propia transacción.
- Una fila aplicada con nombre o checksum diferente detiene el arranque con `CHECKSUM_MISMATCH`. El runner no la corrige en silencio.
- Un error durante el SQL produce `MIGRATION_FAILED`. La transacción de Bun.SQL hace rollback y no deja la fila de registro ni DDL parcial.
- El mensaje de error no incluye SQL, URL ni parámetros. La causa original queda disponible para observabilidad controlada.
- El runner calcula el checksum sobre el texto exacto versionado antes de enviarlo al driver.

## Retiro seguro de Documents

Antes de aplicar `0011`, el runner comprueba si existe la tabla histórica `documents`. Si contiene filas,
exige `PRIME_BOARD_DOCUMENTS_ARCHIVE` (o `documentsArchivePath`) y verifica que la fuente `postgres`
del manifest externo coincida por cantidad y SHA-256. La transacción vuelve a comprobar la fuente y toma
un bloqueo `ACCESS EXCLUSIVE` antes de la comprobación final, para impedir escrituras concurrentes entre
la validación y el `DROP`. Una tabla vacía puede retirarse sin archivo de contenido.

El comando `archive:documents` crea o completa el manifest fuera de la réplica con permisos `0600`.

## Receipts del projector

`0016` registra cada evento aplicado junto con su stream y su fecha. Cuando la tabla está disponible, el
replay usa el receipt como fuente de idempotencia y también procesa eventos que llegaron después con una
fecha anterior al checkpoint. Esto permite backfills fuera de orden; las operaciones del projector deben ser
idempotentes para una instalación que migra con un checkpoint previo y receipts todavía vacíos.

## Validación reproducible

Con `PRIME_BOARD_POSTGRES_URL` apuntando a una instancia local efímera:

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-migrator.ts
```

El script crea una migración temporal, ejecuta dos runners concurrentes, verifica que exista una sola fila y tabla, prueba el rechazo por checksum y provoca una migración fallida para comprobar el rollback. No imprime la URL ni persiste credenciales. La ejecución validada devolvió:

```json
{ "passed": true, "report": { "concurrent": true, "checksum": true, "rollback": true } }
```

El equipo también ejecutó `migratePostgres` con la lista por defecto contra una base vacía. El runner aplicó
las migraciones registradas, incluida `0016`, y registró sus filas en `schema_migrations`.
