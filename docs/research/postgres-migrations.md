# Migrator PostgreSQL de prime-board

- **Ticket:** PRB-428
- **Implementación:** `apps/server/src/db/postgres/migrator.ts`

## Contrato operativo

`migratePostgres(sql, migrations, lockKey)` ordena y valida el registro de migraciones, abre una transacción, toma `pg_advisory_xact_lock` con la clave de la instalación y crea `schema_migrations` si todavía no existe. Cada fila conserva `version`, `name`, el SHA-256 del SQL y `applied_at`.

El runner ejecuta el baseline PostgreSQL como migración `0001/baseline`. `0002/workspace_singleton` garantiza la fila única. Los SQL futuros deben vivir bajo el namespace PostgreSQL y nunca reutilizar archivos SQLite. El runner usa `unsafe(...).simple()` solo para SQL versionado y controlado por el repositorio, nunca para entrada de usuario.

## Seguridad de arranque

- Dos procesos con la misma `lockKey` esperan el mismo advisory transaction lock. Solo uno puede insertar y aplicar una versión; el segundo vuelve a consultar la tabla dentro de su propia transacción.
- Una fila aplicada con nombre o checksum diferente detiene el arranque con `CHECKSUM_MISMATCH`. El runner no la corrige en silencio.
- Un error durante el SQL produce `MIGRATION_FAILED`. La transacción de Bun.SQL hace rollback y no deja la fila de registro ni DDL parcial.
- El mensaje de error no incluye SQL, URL ni parámetros. La causa original queda disponible para observabilidad controlada.
- El runner calcula el checksum sobre el texto exacto versionado antes de enviarlo al driver.

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

El equipo también ejecutó `migratePostgres` con la lista por defecto contra una base vacía. El runner aplicó el baseline y registró una fila en `schema_migrations`.
