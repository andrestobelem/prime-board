# Baseline PostgreSQL de prime-board

- **Ticket:** PRB-427
- **Migraciones fuente:** SQLite `0001`–`0023`
- **Archivo:** `apps/server/src/db/postgres/0001_baseline.sql`

## Decisiones de paridad

El baseline conserva IDs y timestamps como `TEXT`, counters y priority como `INTEGER` y posiciones como `DOUBLE PRECISION`. Así no cambia todavía los formatos de la réplica ni los cursores. Los campos que contienen JSON (`activity.payload`, eventos y filtros) permanecen como `TEXT`. La validación de Bun.SQL/JSONB queda separada del primer esquema para que la migración de módulos no cambie contratos de serialización en silencio. `webhooks.enabled` usa `BOOLEAN` con default `TRUE`; el adaptador futuro debe mapearlo a la semántica booleana del dominio.

El baseline conserva las claves primarias, uniques, checks e índices de las 28 tablas de negocio. Agrega las foreign keys después de crear las tablas para resolver las referencias recursivas y el ciclo `teams`/`workflow_states`. Mantiene las acciones `CASCADE`/`RESTRICT` explícitas de SQLite. El dominio conserva las invariantes cross-scope (por ejemplo, que un state pertenezca al Team de la Issue) hasta que un migrator pueda ejecutar preflight y reportar mismatches sin corregirlos en silencio.

El baseline agrega `schema_migrations(version, name, checksum, applied_at)` para el migrator siguiente. No copia `_migrations`, `issues_fts`, `rowid` ni triggers FTS5 de SQLite.

## Búsqueda

Un trigger de PostgreSQL deriva `issues.search_vector` (un `tsvector`) de `title` y `description`; un índice GIN acelera la consulta. El baseline usa la configuración `simple` como equivalencia inicial. La migración del módulo de búsqueda debe resolver el parser de queries y la equivalencia de prefijos, acentos y frases. Al combinar ambas columnas, una frase podría cruzar el límite `title`/`description`; este DDL no declara paridad estricta por columna. El sistema no importa filas de FTS5: reconstruye el vector desde el contenido de `issues`.

## Ejecución

Con PostgreSQL local administrado por el runbook de Podman:

```bash
scripts/postgres-dev.sh up
scripts/postgres-dev.sh baseline
scripts/postgres-dev.sh check
```

`baseline` aplica el SQL con `ON_ERROR_STOP=1` y `--single-transaction` dentro de una base vacía. Registra la versión 1 con su SHA-256 y reporta el número de tablas públicas. No recibe ni imprime credenciales.

## Verificación realizada

El equipo verificó en un PostgreSQL 16 Alpine efímero:

- Aplicación desde cero: `BEGIN`, 29 tablas públicas (28 de negocio + metadata),
  foreign keys, checks, índices y trigger de búsqueda.
- Inserción de Workspace, actor, Team, workflow state e issue; el issue se
  encontró mediante `search_vector @@ plainto_tsquery('simple', ...)`.
- Inserción de label, relación `issue_labels` y actividad; rollback del fixture
  de validación dejó la base vacía.
- `scripts/postgres-dev.sh check` pasó después del baseline.

El equipo eliminó el contenedor, la red, el volumen, el secreto y la máquina Podman usados para la prueba. No se versionan datos, dumps ni credenciales.
