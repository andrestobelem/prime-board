# Migrator PostgreSQL de prime-board

- **Ticket:** PRB-428
- **Implementación:** `apps/server/src/db/postgres/migrator.ts`

## Contrato operativo

`migratePostgres(sql, migrations, lockKey)` ordena y valida el registro de
migraciones, abre una transacción, toma `pg_advisory_xact_lock` con la clave de
la instalación y crea `schema_migrations` si aún no existe. Cada fila conserva
`version`, `name`, SHA-256 de los SQL y `applied_at`.

El baseline PostgreSQL se ejecuta como la migración `0001/baseline`; los SQL
futuros deben vivir bajo el namespace PostgreSQL y nunca reutilizar los archivos
SQLite. El runner usa `unsafe(...).simple()` únicamente para SQL versionado y
controlado por el repositorio, no para entrada de usuario.

## Seguridad de arranque

- Dos procesos que usan la misma `lockKey` esperan el mismo advisory transaction
  lock; solo uno puede insertar/aplicar una versión y el segundo reconsulta la
  tabla dentro de su propia transacción.
- Una fila aplicada con nombre o checksum diferente detiene el arranque con
  `CHECKSUM_MISMATCH`; no se corrige silenciosamente.
- Un error durante el SQL produce `MIGRATION_FAILED`; la transacción de Bun.SQL
  hace rollback y no queda la fila de registro ni DDL parcial.
- El mensaje de error no incluye SQL, URL ni parámetros. La causa original queda
  disponible para observabilidad controlada.
- El checksum se calcula sobre el texto exacto versionado, antes de enviarlo al
  driver.

## Validación reproducible

Con `PRIME_BOARD_POSTGRES_URL` apuntando a una instancia local efímera:

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-migrator.ts
```

El script crea una migración temporal, ejecuta dos runners concurrentes,
verifica que haya una sola fila y tabla, prueba el rechazo por checksum y
provoca una migración fallida para comprobar rollback. No imprime la URL ni
persiste credenciales. La ejecución validada devolvió:

```json
{ "passed": true, "report": { "concurrent": true, "checksum": true, "rollback": true } }
```

También se ejecutó `migratePostgres` con la lista por defecto contra una base
vacía: aplicó el baseline y registró una fila en `schema_migrations`.
