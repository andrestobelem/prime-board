# Baseline PostgreSQL de prime-board

- **Ticket:** PRB-427
- **Migraciones fuente:** SQLite `0001`–`0023`
- **Archivo:** `apps/server/src/db/postgres/0001_baseline.sql`

## Decisiones de paridad

El baseline conserva IDs y timestamps como `TEXT`, counters/priority como
`INTEGER` y posiciones como `DOUBLE PRECISION`, para no cambiar todavía los
formatos de la réplica ni los cursores. Los campos que hoy contienen JSON
(`activity.payload`, eventos y filtros) permanecen como `TEXT`; la validación de
Bun.SQL/JSONB queda separada del primer esquema para que la migración de módulos
no cambie contratos de serialización silenciosamente. `webhooks.enabled` es
`BOOLEAN` con default `TRUE`, que el adaptador futuro debe mapear a la semántica
booleana del dominio.

Las claves primarias, uniques, checks e índices de las 28 tablas de negocio se
conservan. Las foreign keys se agregan después de crear las tablas para resolver
las referencias recursivas y el ciclo `teams`/`workflow_states`; se mantienen
las acciones `CASCADE`/`RESTRICT` explícitas que existen en SQLite. Las
invariantes cross-scope (por ejemplo, que un state pertenezca al Team del issue)
siguen en el dominio hasta que un migrator pueda ejecutar preflight y reportar
mismatches sin corregirlos silenciosamente.

El baseline agrega `schema_migrations(version, name, checksum, applied_at)` para
el migrator siguiente. No copia `_migrations`, `issues_fts`, `rowid` ni triggers
FTS5 de SQLite.

## Búsqueda

`issues.search_vector` es un `tsvector` derivado mediante un trigger PostgreSQL
sobre `title` y `description`, con índice GIN. Usa la configuración `simple`
como equivalencia inicial; el parser de consultas y equivalencia de prefijos,
acentos y frases quedan para la migración del módulo de búsqueda. No se importan
filas de FTS5: el vector se reconstruye desde el contenido de `issues`.

## Ejecución

Con PostgreSQL local administrado por el runbook de Podman:

```bash
scripts/postgres-dev.sh up
scripts/postgres-dev.sh baseline
scripts/postgres-dev.sh check
```

`baseline` aplica el SQL con `ON_ERROR_STOP=1` dentro de una base vacía y
reporta el número de tablas públicas. No recibe ni imprime credenciales.

## Verificación realizada

Sobre un PostgreSQL 16 Alpine efímero se verificó:

- Aplicación desde cero: `BEGIN`, 29 tablas públicas (28 de negocio + metadata),
  foreign keys, checks, índices y trigger de búsqueda.
- Inserción de Workspace, actor, Team, workflow state e issue; el issue se
  encontró mediante `search_vector @@ plainto_tsquery('simple', ...)`.
- Inserción de label, relación `issue_labels` y actividad; rollback del fixture
  de validación dejó la base vacía.
- `scripts/postgres-dev.sh check` pasó después del baseline.

El contenedor, red, volumen, secreto y máquina Podman usados para la prueba se
eliminaron. No se versionan datos, dumps ni credenciales.
