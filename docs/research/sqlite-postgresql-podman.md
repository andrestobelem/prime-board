# Migración de SQLite a PostgreSQL con Podman

**Estado:** investigación completada; no modifica todavía el runtime.
**Ticket operativo:** `PRB-410`
**Fecha del relevamiento:** 2026-08-19

## Resumen ejecutivo

La migración es viable, pero no es un cambio de imagen de contenedor ni un reemplazo
mecánico del archivo `.db`. El servidor depende de `bun:sqlite` y de su API síncrona en
la capa de dominio; PostgreSQL exige un cliente de red asíncrono, un pool y transacciones
que conserven la misma conexión. El trabajo debe tratarse como una migración de la capa
de persistencia y como un cutover con downtime planificado.

La recomendación para una primera implementación es:

1. Ejecutar PostgreSQL en un contenedor Podman con un volumen nombrado y healthcheck.
2. Usar `Bun.SQL` como cliente PostgreSQL, detrás de una interfaz propia de persistencia;
   no propagar la API de `Bun.SQL` por todo el dominio.
3. Crear un esquema PostgreSQL nuevo y versionado. **No** ejecutar sin cambios las
   migraciones SQLite existentes.
4. Migrar directamente desde una copia consistente de SQLite, conservando IDs, hashes de
   API keys y secretos de webhooks. La réplica `.prime-board/` sirve para reconstruir el
   contenido del board, pero deliberadamente no contiene credenciales completas.
5. Hacer primero una migración offline, mantener SQLite intacto hasta terminar la
   validación y conservar un rollback por cambio de configuración.

Esto reabre la condición prevista en [ADR-0001](../adr/0001-bun-typescript-sqlite.md), que
ratifica SQLite mientras prime-board sea local-first, single-tenant y de proceso único.
Este documento no reemplaza esa decisión ni autoriza todavía el cambio de runtime.

## Alcance y método

Se revisaron el código de `apps/server`, las 23 migraciones SQL presentes en el árbol de
trabajo, los tests de persistencia/exportación y la documentación del modelo. También se
consultaron fuentes primarias oficiales de Bun, PostgreSQL, Podman, la imagen oficial de
PostgreSQL y SQLite. Las URLs y la fecha de consulta están en [Fuentes](#fuentes).

No se implementó el driver, no se levantó un PostgreSQL de producción, no se ejecutó un
cutover y no se modificaron las migraciones actuales. El inventario refleja el árbol
revisado el 2026-08-19; debe repetirse antes de empezar la implementación.

## 1. Estado actual verificado

### 1.1 Runtime y configuración

- `apps/server/src/db/database.ts` importa `Database` desde `bun:sqlite`, abre un archivo
  (`PRIME_BOARD_DB` o `~/.prime-board/prime-board.db`), activa WAL y foreign keys mediante
  `PRAGMA`, y ejecuta migraciones síncronas al arrancar.
- La tabla `_migrations` registra versiones y cada migración se ejecuta dentro de una
  transacción SQLite. El árbol revisado llega a la versión 23 (`0023_webhook_team_scope`).
- `apps/server/src/config.ts` no tiene una URL de base de datos: solo conoce
  `PRIME_BOARD_DB` como camino local.
- `apps/server/src/server.ts`, los contextos GraphQL, el dispatcher de webhooks, el
  exportador/importador y prácticamente todos los módulos de dominio reciben el tipo
  `Database` de SQLite.
- Un escaneo del código de servidor encontró 32 importaciones de `bun:sqlite` (incluyendo
  tests), aproximadamente 395 llamadas `.query()`, 298 `.get()`, 84 `.all()`, 27
  `.values()`, 140 `.run()` y 25 transacciones. Es una estimación de alcance, no un
  contrato: debe actualizarse al implementar.

### 1.2 Modelo persistido

El modelo usa IDs UUID v7 serializados como `TEXT`, timestamps ISO-8601 como `TEXT`,
soft-delete por `archived_at` y una única fila `workspace`. Las tablas de negocio son:

- `workspace`, `actors`, `api_keys`, `teams`, `workflow_states`;
- `projects`, `project_teams`, `milestones`, `cycles`, `initiatives`,
  `initiative_projects`, `initiative_teams`, `project_updates`;
- `issues`, `issue_relations`, `labels`, `issue_labels`, `comments`, `activity`, `reviews`;
- `saved_views`, `inbox_receipts`, `team_memberships`, `favorites`, `actor_invitations`;
- `webhooks`, `api_key_scopes` y `api_key_team_limits`;
- `_migrations` e `issues_fts` son infraestructura de SQLite, no datos de negocio que
  deban copiarse literalmente.

Hay foreign keys, checks, índices parciales únicos para favoritos y varios índices de
consulta. `issues_fts` es una tabla virtual FTS5 sincronizada con triggers y usa el
`rowid` interno de SQLite.

### 1.3 Réplica del repositorio y credenciales

`PRIME_BOARD_REPO` replica snapshots, logs de actividad y metadata en `.prime-board/`.
El exportador sí conserva metadata no secreta de API keys (nombre, actor, scopes,
expiración y estado), pero **no** exporta hashes de API keys ni secretos de webhooks. Un
rebuild desde la réplica puede dejar keys `redacted:*` inutilizables hasta rotarlas y no
puede reconstruir secretos de webhooks que no estén en la base fuente.

Por eso:

- para una migración con preservación de autenticación hay que copiar `api_keys.hash` y
  `webhooks.secret` directamente desde SQLite bajo un canal protegido;
- si se migra solo desde `.prime-board/`, hay que emitir nuevas API keys y registrar de
  nuevo los webhooks como parte del cutover;
- la réplica es una excelente contingencia para el contenido legible del board, pero no es
  un backup completo de la base.

## 2. Brechas técnicas que hay que resolver

### 2.1 API síncrona frente a cliente de red asíncrono

`bun:sqlite` permite `query().get/all/values/run` síncronos y
`db.transaction(() => {})()`. PostgreSQL introduce I/O de red: las funciones de dominio,
resolvers, autorización, export/import, seed, scripts y tests deben volverse `async` y
usar `await` de extremo a extremo.

La interfaz recomendada es una capa pequeña, por ejemplo:

```ts
interface Database {
  one<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  many<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<{ rowCount: number }>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

La implementación puede usar `Bun.SQL`; la interfaz evita que tests, dominio y GraphQL
queden acoplados a un driver concreto. Toda operación que componga SQL debe separar
valores parametrizables de fragmentos estructurales previamente allowlisted. No se debe
concatenar input del usuario en `sql.unsafe`.

`Bun.SQL` es una opción razonable porque el runtime actual es Bun 1.3.14 y la documentación
oficial describe una API Promise-based para PostgreSQL, pool configurable y
`sql.begin(...)`, que reserva una conexión dedicada para la transacción. Hay que hacer un
spike pequeño antes de migrar todo: validar tipos de retorno, `rowCount`, `RETURNING`,
JSON, errores y transacciones anidadas.

### 2.2 SQL específico de SQLite

El inventario de incompatibilidades conocidas incluye:

| Ubicación/construcción actual                            | Trabajo requerido en PostgreSQL                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?1`, `?2`, etc. y `.query()`                            | Migrar a `$1`, `$2` o a tagged templates; el `ParamSink` de filtros debe producir la sintaxis del driver.                                                      |
| `PRAGMA journal_mode = WAL` y `PRAGMA foreign_keys = ON` | Eliminar ambos. WAL, checkpoints y foreign keys son responsabilidades/configuración de PostgreSQL.                                                             |
| `issues_fts` FTS5, `MATCH`, `rowid` y triggers           | Reemplazar por `tsvector` + índice GIN y un parser de búsqueda equivalente. No copiar `issues_fts`.                                                            |
| `inbox_receipts.rowid` en `auth/scope-dispatch.ts`       | Es una dependencia oculta del rowid SQLite. Definir un ID explícito (la semántica esperada parece ser `activity_id`) y eliminar el fallback.                   |
| `max(next_issue_number, ?2 + 1)` en un `UPDATE`          | En PostgreSQL debe ser `GREATEST(next_issue_number, $2 + 1)`; `max` es agregada allí. Validar la asignación concurrente de números con `UPDATE ... RETURNING`. |
| `.run().changes`                                         | Usar `rowCount` del driver y comprobar su semántica en `UPDATE ... WHERE`.                                                                                     |
| `typeof(position) = 'integer'`                           | Sustituir por el tipo PostgreSQL y un `CHECK` equivalente (`position >= 0`); el tipo ya impide valores no enteros si corresponde.                              |
| `INTEGER` booleano (`webhooks.enabled` con 0/1)          | Elegir `boolean` y adaptar `mapWebhook`, o conservar temporalmente `smallint`; probar que la API siga devolviendo `Boolean`.                                   |
| JSON en columnas `TEXT`                                  | Fase de paridad: conservar `TEXT` y hacer `JSON.parse/stringify`. Fase posterior opcional: `jsonb`, con conversión explícita y tests de exportación.           |
| `ALTER TABLE` incremental SQLite                         | Crear DDL PostgreSQL propio. No ejecutar literalmente los 23 archivos porque contienen FTS5, `rowid`, `typeof` y semántica de tipos SQLite.                    |
| `                                                        |                                                                                                                                                                | `, `lower`, `coalesce`, FKs, `CHECK` | Son generalmente portables, pero deben pasar por la suite PostgreSQL, especialmente nullability, collation y cascadas. |

No hay que asumir que una query válida en SQLite conserva la misma concurrencia en
PostgreSQL. La numeración de issues, aceptación de invitaciones, rotación de keys y
cualquier operación read-modify-write deben quedar en una transacción y probarse con
requests concurrentes.

### 2.3 Búsqueda full-text

Los tests actuales exigen, entre otras cosas, prefijos (`webhook` encuentra `webhooks`),
frases exactas entre comillas, insensibilidad a mayúsculas y acentos, caracteres
especiales seguros y entradas FTS malformadas sin filtrar un error interno.

El reemplazo propuesto es una columna `tsvector` derivada de título y descripción, un
índice GIN y consultas `@@` con configuración `simple`. Hay que decidir y probar uno de
estos mecanismos para acentos:

- extensión oficial `unaccent` en la base y una expresión/trigger de normalización;
- normalización explícita en la aplicación antes de construir el vector;
- una función PostgreSQL propia declarada con la volatilidad adecuada.

El parser actual de `ftsQuery` no se puede pasar sin cambios a `to_tsquery`: debe traducir
prefijos a `:*`, frases a operadores de proximidad y descartar/escapar tokens inválidos.
La búsqueda debe probarse con la matriz existente de `apps/server/src/graphql/fts.test.ts`
y con datos migrados. El vector es derivado: se reconstruye en el destino y no se cuenta
como una tabla migrada.

## 3. Arquitectura PostgreSQL + Podman

### 3.1 Forma recomendada para la primera etapa

En desarrollo y en la instalación local, dejar el proceso Bun en el host y ejecutar solo
PostgreSQL en Podman. Así el endpoint de la aplicación sigue siendo el actual y se reduce
el número de variables durante la migración:

```text
UI / CLI / MCP
       │
       ▼
  proceso Bun ── TCP 127.0.0.1:5432 ── PostgreSQL en Podman
                                      │
                                      ▼
                         volumen prime-board-pgdata
```

Más adelante se puede contenerizar también Bun. Dentro de una red Podman el host del
servidor sería el nombre del contenedor, pero desde Bun ejecutándose en macOS/Linux el
endpoint inicial es `127.0.0.1` por el port mapping.

### 3.2 Arranque reproducible de PostgreSQL

Los comandos siguientes son un runbook de desarrollo. El tag `17` es un ejemplo de major
soportado; para un entorno compartido hay que fijar una major aprobada y, preferentemente,
un digest, y registrar la política de actualización.

```bash
# Solo macOS/Windows si la máquina de Podman no está activa.
podman machine start

export PB_PG_CONTAINER=prime-board-postgres
export PB_PG_NETWORK=prime-board
export PB_PG_VOLUME=prime-board-pgdata
export PB_PG_DB=primeboard
export PB_PG_USER=primeboard
podman network exists "$PB_PG_NETWORK" || podman network create "$PB_PG_NETWORK"
podman volume exists "$PB_PG_VOLUME" || podman volume create "$PB_PG_VOLUME"
read -r -s -p 'PostgreSQL password: ' PB_PG_PASSWORD; printf '\n'
printf '%s' "$PB_PG_PASSWORD" | podman secret create --replace \
  prime-board-pg-password -
unset PB_PG_PASSWORD

podman run --detach --name "$PB_PG_CONTAINER" \
  --network "$PB_PG_NETWORK" \
  --publish 127.0.0.1:5432:5432 \
  --restart unless-stopped \
  --health-cmd 'pg_isready -U primeboard -d primeboard' \
  --health-interval 10s --health-timeout 5s --health-retries 6 \
  --secret prime-board-pg-password,type=mount \
  --env POSTGRES_USER="$PB_PG_USER" \
  --env POSTGRES_DB="$PB_PG_DB" \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/prime-board-pg-password \
  --volume "$PB_PG_VOLUME":/var/lib/postgresql/data \
  docker.io/library/postgres:17

until podman exec "$PB_PG_CONTAINER" pg_isready -U "$PB_PG_USER" -d "$PB_PG_DB"; do
  sleep 1
done
podman healthcheck run "$PB_PG_CONTAINER"
podman inspect --format '{{.State.Health.Status}}' "$PB_PG_CONTAINER"
```

La imagen oficial solo procesa sus variables de inicialización y los scripts de
`/docker-entrypoint-initdb.d` cuando el directorio de datos está vacío. Por eso el esquema
versionado de prime-board debe ejecutarse desde el migrator de la aplicación (o desde una
imagen de migración explícita), no depender de montar un SQL que deje de ejecutarse cuando
el volumen ya existe.

El secreto no debe entrar al repositorio ni quedar en el historial de shell. En una
instalación compartida hay que crear además un rol de aplicación sin privilegios de
administrador y reservar el rol de migración para el arranque/cutover.

Para el primer contrato de configuración se propone añadir una variable como
`PRIME_BOARD_DATABASE_URL` (o componentes equivalentes), con `PRIME_BOARD_DB` reservado a
SQLite durante la transición. Ejemplo conceptual, sin incluir credenciales reales:

```bash
export PRIME_BOARD_DATABASE_URL='postgres://primeboard:<url-encoded-password>@127.0.0.1:5432/primeboard'
bun run server
```

No usar ese ejemplo hasta que el driver y `loadConfig` lo implementen. En local se puede
usar `sslmode=disable` solo porque el socket está enlazado a loopback; cualquier conexión
remota debe usar TLS, certificado verificado y una política de red explícita.

### 3.3 Operación cotidiana

```bash
podman logs -f prime-board-postgres
podman stop prime-board-postgres
podman start prime-board-postgres
podman exec prime-board-postgres pg_isready -U primeboard -d primeboard

# No borra el volumen: borrar el contenedor y borrar el volumen son operaciones distintas.
podman rm -f prime-board-postgres
```

Antes de `podman volume rm prime-board-pgdata` hay que tener un dump verificado. El
healthcheck del contenedor no reemplaza el `/health` de prime-board: el servidor debe
comprobar `SELECT 1` y no anunciarse listo si el pool no puede conectarse.

### 3.4 Backup y restore

Para PostgreSQL, el backup operativo recomendado es lógico y probado con `pg_dump`/`pg_restore`;
el volumen Podman no es el único backup. Ejemplo usando la autenticación local del usuario
`postgres` dentro del contenedor:

```bash
mkdir -p backups
podman exec --user postgres prime-board-postgres \
  pg_dump --format=custom --file=/tmp/prime-board.dump primeboard
podman cp prime-board-postgres:/tmp/prime-board.dump \
  "backups/prime-board-$(date -u +%Y%m%dT%H%M%SZ).dump"

# En una base de restauración, no sobre la única copia en uso.
podman cp backups/prime-board-YYYYMMDDTHHMMSSZ.dump \
  prime-board-postgres:/tmp/restore.dump
podman exec --user postgres prime-board-postgres \
  pg_restore --clean --if-exists --exit-on-error \
  --dbname=primeboard /tmp/restore.dump
```

La sintaxis exacta de autenticación local debe validarse en el major elegido; si el
entorno exige contraseña, usar el secret montado o un mecanismo equivalente, nunca una
contraseña escrita en el comando. Un restore se valida levantando una instancia/volumen
de prueba, ejecutando conteos, checks de FKs, búsquedas y el smoke GraphQL completo.

## 4. Esquema y estrategia de migración de datos

### 4.1 DDL PostgreSQL

Crear una primera migración PostgreSQL de baseline que incluya el esquema final actual y
marque una nueva historia de migraciones. No conviene ejecutar 0001–0023 como si fueran
portables. El baseline debe:

- crear las tablas de negocio y todos los índices necesarios;
- definir FKs y acciones `CASCADE`/`RESTRICT` de forma explícita;
- conservar `workspace` singular y los IDs actuales para no romper referencias ni logs;
- resolver el self-reference `issues.parent_id` con carga en dos pasos o FK diferible;
- incluir `default_state_id` después de crear `workflow_states`;
- reemplazar el índice FTS5 por el vector PostgreSQL;
- dejar una tabla de migraciones PostgreSQL con versión, nombre, fecha y checksum;
- tomar un advisory lock durante la migración para que dos instancias no apliquen el mismo
  DDL concurrentemente.

Mapeo inicial recomendado para reducir cambios de API:

| SQLite actual            | PostgreSQL inicial                  | Nota                                                                                                                                                |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEXT` UUID v7           | `text`                              | Evita convertir IDs y mantiene compatibilidad con `.prime-board`. Se puede evaluar `uuid` después de medir impacto.                                 |
| `INTEGER`                | `integer`                           | Validar contadores y `number`.                                                                                                                      |
| `REAL`                   | `double precision`                  | Aplica a `position` y `sort_order`.                                                                                                                 |
| timestamp ISO `TEXT`     | `text` en la fase de paridad        | Evita que el driver normalice strings y altere cursores/exportaciones. Considerar `timestamptz` en una migración posterior con adaptador explícito. |
| JSON serializado `TEXT`  | `text` en la fase de paridad        | `payload`, filtros y metadata siguen usando `JSON.parse/stringify`; `jsonb` queda como mejora independiente.                                        |
| `enabled` 0/1            | `boolean` o `smallint`              | Si se usa `boolean`, adaptar el mapper y el importador.                                                                                             |
| índices únicos parciales | `CREATE UNIQUE INDEX ... WHERE ...` | PostgreSQL soporta la intención de favoritos; validarla con datos existentes.                                                                       |

La decisión de conservar texto al principio es deliberada: primero se busca paridad
funcional y un rollback sencillo. Tipar timestamps/JSON e introducir índices nuevos debe
ser una segunda decisión, no una consecuencia accidental del cambio de motor.

### 4.2 Carga directa desde una copia consistente

La ruta preferida para una migración lossless es un migrator que lea SQLite y escriba
PostgreSQL con parámetros, preserve los IDs y copie también secretos. Debe ser reanudable
por fases o reiniciable de forma idempotente; no debe hacer llamadas GraphQL para recrear
filas porque perdería timestamps, autoría y credenciales.

Orden de carga sugerido (ajustar al DDL final):

1. `workspace` y `actors`.
2. `teams` sin `default_state_id`; `workflow_states`; luego actualizar el estado default.
3. `projects`, `labels`, `initiatives` y sus owners.
4. `project_teams`, `initiative_projects`, `initiative_teams`, `milestones` y `cycles`.
5. `api_keys` (incluyendo `hash`, expiración, revocación y rotación), scopes y límites.
6. `actor_invitations` y `webhooks` (incluyendo `secret`, eventos, owner, team y enabled).
7. `issues` con `parent_id` nulo, y después un segundo paso para restaurar padres.
8. `issue_relations`, `issue_labels`, `comments`, `activity`, `reviews`, `project_updates`.
9. `inbox_receipts`, `team_memberships` y `favorites`.
10. reconstrucción de `search_vector`, índices derivados y marcador de baseline.

La carga debe ejecutarse con una cuenta de migración, dentro de una transacción por fase o
con staging tables. El origen se congela; la copia no se debe hacer con un `cp` de un
SQLite vivo en WAL. Primero detener el servidor o usar la Online Backup API de SQLite,
conservar el archivo fuente y verificar que la copia abre y que sus foreign keys están
activas.

### 4.3 Alternativa basada en la réplica

La secuencia `export` + `rebuild` es útil cuando se necesita reconstruir el contenido del
board en otra instalación, pero no es la migración predeterminada:

- conserva IDs/nombres y buena parte de la historia funcional;
- omite hashes de API keys y secretos de webhooks por diseño;
- puede dejar credenciales redacted y exige rotación/recreación;
- no debe confundirse con una copia de todas las tablas ni con un backup de PostgreSQL.

Usarla solo si se acepta explícitamente regenerar credenciales y validar qué entidades no
forman parte del formato de réplica.

## 5. Plan de implementación y cutover

### Fase A — spike aislado

- Crear la interfaz `Database` y un adaptador mínimo `Bun.SQL`.
- Probar `one/many/execute`, parámetros `$n`, errores, `RETURNING`, pool y
  `transaction` con rollback.
- Probar transacciones anidadas actuales (en particular aceptación de invitación y creación
  de API key) y reemplazarlas por composición de una transacción exterior, savepoints o
  una API explícita.
- Probar `Bun.randomUUIDv7`, fechas, JSON, booleanos y el `search_vector`.

### Fase B — schema y migrator

- Añadir `PRIME_BOARD_DATABASE_URL` y selección de backend sin romper SQLite.
- Crear baseline PostgreSQL y migraciones futuras separadas de los `.sql` SQLite.
- Implementar lock de migraciones, cierre ordenado del pool y `/health` con `SELECT 1`.
- Escribir el data pump con modo `--dry-run`, conteos por tabla y logs sin secretos.
- No borrar ni modificar `PRIME_BOARD_DB` hasta completar el cutover.

### Fase C — dominio y tests

- Convertir a async dominio, auth, permisos, resolvers, webhooks, export/import, seed y
  scripts; eliminar tipos `bun:sqlite` de producción.
- Cambiar todas las consultas y el filtro de issues; revisar `rowid`, `MATCH`,
  `GREATEST`, placeholders y valores booleanos.
- Cambiar `test-helpers` para que los tests de integración ejecuten PostgreSQL efímero en
  Podman. Mantener tests unitarios puros sin acceso a DB donde corresponda.
- Cubrir concurrencia de numeración, invitaciones, scopes, relaciones/FKs, favoritos,
  cascadas, webhooks y exportación/rebuild.

### Fase D — ensayo y corte

1. Medir filas, tamaño y duración de la carga en una copia; guardar el reporte.
2. Levantar un PostgreSQL limpio con un volumen de staging y correr el baseline.
3. Parar el servidor SQLite y rechazar nuevas escrituras.
4. Crear backup consistente de SQLite y copiarlo al entorno de migración.
5. Ejecutar el data pump directo, reconstruir búsqueda y correr validaciones.
6. Comparar conteos, claves naturales, timestamps extremos, checks de FK, resultados FTS,
   exportación de repo, `viewer`, lecturas/mutaciones GraphQL y una firma real de webhook.
7. Crear/rotar una API key de emergencia y verificar autenticación.
8. Cambiar `PRIME_BOARD_DATABASE_URL`, arrancar el servidor y observar logs/health.
9. Mantener SQLite de solo lectura durante el período de observación y tomar el primer
   `pg_dump` exitoso antes de declarar el corte terminado.

### Rollback

- Antes de aceptar escrituras en PostgreSQL, detener el proceso y volver a arrancar con
  `PRIME_BOARD_DB` y la copia SQLite congelada.
- Después de aceptar escrituras en PostgreSQL no hay sincronización automática inversa. Un
  rollback al SQLite anterior pierde las escrituras hechas desde el corte; para evitarlas,
  declarar el cambio irreversible solo después de la validación y mantener una ventana sin
  tráfico o un plan explícito de reconciliación.
- Si falla una migración de esquema antes del corte, destruir solo el volumen de staging y
  repetir desde el backup; nunca borrar el volumen de producción como primera reacción.
- Las migraciones PostgreSQL futuras deben tener rollback operacional (backup + restore),
  aunque no todas requieran un `DOWN` automático.

## 6. Criterios de aceptación

La implementación futura no está lista para retirar SQLite hasta demostrar:

- `bun run typecheck`, `bun test` y build pasan con el backend PostgreSQL.
- Dos arranques concurrentes aplican migraciones una sola vez y dejan el mismo checksum.
- El recuento de cada tabla de negocio coincide con SQLite, excepto las estructuras
  derivadas explícitamente documentadas.
- No quedan foreign keys huérfanas, números duplicados por Team ni claves naturales
  ambiguas; `default_state_id`, padres, relaciones y cascadas se conservan.
- Una API key existente autentica (prueba hash copiado), una key revocada no autentica y
  un webhook existente conserva su firma/secret.
- La suite FTS conserva prefijo, frase, acentos, mayúsculas, caracteres especiales y
  entradas inválidas seguras.
- El export de PostgreSQL produce el mismo contenido lógico que el snapshot de SQLite,
  ignorando IDs recién generados solo donde el formato ya los define como efímeros.
- `health` detecta una base caída; el pool se cierra correctamente al terminar el proceso;
  no hay fugas ni transacciones que crucen conexiones.
- `pg_dump` y `pg_restore` se ejecutan en una instancia limpia y la instancia restaurada
  pasa el mismo smoke test.
- El runbook puede ser ejecutado por otra persona sin credenciales incrustadas y con una
  major/digest de imagen registrada.

## 7. Decisiones pendientes antes de programar

1. Major y digest de `docker.io/library/postgres`, y política de actualización.
2. `Bun.SQL` como driver definitivo frente a otro cliente; debe cerrarse con el spike,
   no por preferencia teórica.
3. Tamaño máximo del pool, timeouts, `statement_timeout` y límites de conexiones del
   proceso Bun.
4. `text` de paridad frente a `timestamptz`/`jsonb` en el primer baseline.
5. Estrategia de acentos y parser de frases/prefijos (`unaccent` o normalización de app).
6. Rol de migración separado del rol de aplicación y política TLS fuera de loopback.
7. Si la prueba de integración crea una base por proceso, un schema por test o un
   contenedor efímero; no compartir estado entre tests paralelos.
8. Si el primer despliegue mantiene Bun en el host o ejecuta toda la aplicación en Podman.
9. Retención, cifrado y destino externo de backups; un volumen local no es una política de
   backup.

## Checklist operativo

- [ ] Ticket de implementación separado y ADR que reabra formalmente ADR-0001.
- [ ] Spike de driver y transacciones aprobado.
- [ ] DDL PostgreSQL baseline revisado.
- [ ] Data pump lossless probado con datos representativos.
- [ ] Imagen major/digest, red, volumen y secreto registrados.
- [ ] Backup SQLite consistente y backup PostgreSQL restaurable.
- [ ] Suite async + integración Podman verde.
- [ ] Ensayo de cutover y rollback cronometrados.
- [ ] Conteos, FKs, FTS, GraphQL, auth, webhooks y export comparados.
- [ ] Ventana de corte comunicada; SQLite congelado y retenido.
- [ ] Primer `pg_dump` post-corte verificado.

## Fuentes

Consultadas el 2026-08-19. Las fuentes de producto y runtime son primarias; los enlaces
locales describen el código de este repositorio.

### Repositorio

- [`apps/server/src/config.ts`](../../apps/server/src/config.ts) — configuración actual y `PRIME_BOARD_DB`.
- [`apps/server/src/db/database.ts`](../../apps/server/src/db/database.ts) — apertura SQLite, WAL, foreign keys y migrator hasta v23.
- [`apps/server/src/db/migrations/0001_init.sql`](../../apps/server/src/db/migrations/0001_init.sql) y [`migrations/`](../../apps/server/src/db/migrations/) — esquema, FKs, checks, FTS5 y evolución.
- [`apps/server/src/domain/filters.ts`](../../apps/server/src/domain/filters.ts) y [`apps/server/src/graphql/fts.test.ts`](../../apps/server/src/graphql/fts.test.ts) — parser y contrato de búsqueda.
- [`apps/server/src/auth/scope-dispatch.ts`](../../apps/server/src/auth/scope-dispatch.ts) — dependencia de `inbox_receipts.rowid`.
- [`apps/server/src/export/exporter.ts`](../../apps/server/src/export/exporter.ts) y [`importer.ts`](../../apps/server/src/export/importer.ts) — alcance de la réplica y tratamiento de credenciales.
- [`docs/specs/mvp.md`](../specs/mvp.md) y [`docs/adr/0001-bun-typescript-sqlite.md`](../adr/0001-bun-typescript-sqlite.md) — contrato y decisión vigente.

### Fuentes oficiales externas

- [Bun SQL](https://bun.com/docs/runtime/sql) — API Promise-based, PostgreSQL, pool,
  `sql.unsafe` parametrizado y `sql.begin`.
- [PostgreSQL: tipos UUID](https://www.postgresql.org/docs/current/datatype-uuid.html) —
  posibilidad de usar `uuid` sin imponerla en la primera fase.
- [PostgreSQL: búsqueda full-text](https://www.postgresql.org/docs/current/textsearch.html),
  [índices](https://www.postgresql.org/docs/current/gin.html) y
  [extensión `unaccent`](https://www.postgresql.org/docs/current/unaccent.html) —
  `tsvector`, GIN, normalización y configuración de búsqueda.
- [PostgreSQL: constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
  y [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) y [advisory locks](https://www.postgresql.org/docs/current/functions-admin.html)
  — FKs, checks y coordinación de migraciones/concurrencia.
- [PostgreSQL: backup](https://www.postgresql.org/docs/current/backup.html),
  [`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html) y
  [`pg_restore`](https://www.postgresql.org/docs/current/app-pgrestore.html) — backup
  lógico, restore y validación.
- [Imagen oficial `postgres`](https://github.com/docker-library/docs/blob/master/postgres/README.md) —
  `POSTGRES_*`, `POSTGRES_PASSWORD_FILE` y scripts de inicialización solo sobre volumen
  vacío.
- [Podman `run`](https://docs.podman.io/en/latest/markdown/podman-run.1.html),
  [volúmenes](https://docs.podman.io/en/latest/markdown/podman-volume.1.html),
  [secretos](https://docs.podman.io/en/latest/markdown/podman-secret-create.1.html) y
  [healthchecks](https://docs.podman.io/en/latest/markdown/podman-healthcheck.1.html)
  — red, volumen nombrado, secretos montados y healthcheck.
- [SQLite Online Backup API](https://www.sqlite.org/backup.html) — copia consistente
  antes de leer el archivo fuente en WAL.

## Addendum: rediseño del CDC para conservar el repo como fuente de verdad

**Decisión posterior:** para la topología PostgreSQL objetivo, el repo deja de ser una réplica
pasiva. El Log append-only de `.prime-board/` es la fuente canónica del estado compartido; los
`.md`, `meta/*.json` y PostgreSQL son proyecciones derivadas. La decisión está registrada en
[ADR-0017](../adr/0017-event-log-repo-source-postgresql.md).

### Flujo canónico

```text
comando GraphQL/CLI/MCP
        │
        ▼
validar + generar evento
        │
        ▼
append Log + commit Git       ← autoridad
        │
        ├──► reducer → Issue Markdown/meta
        └──► projector idempotente → PostgreSQL
```

El PostgreSQL objetivo no debe recibir escrituras de negocio directas. Su función es servir
consultas, autorización y proyecciones operativas; un checkpoint permite reanudar el projector y
un replay permite reconstruirlo desde cero. Un fallo de PostgreSQL no invalida un evento ya
commiteado: deja la proyección atrasada y debe ser visible como lag, no como una mutación perdida.

### Qué significa “CDC” aquí

No se usará el WAL de PostgreSQL como CDC canónico. El WAL puede servir para recuperación del
motor, pero capturarlo para producir Markdown invertiría la autoridad: primero existiría un
cambio en la DB y después una réplica eventual en Git. El mecanismo de cambio de dominio será el
Log versionado del repo. `Activity` pasa a ser una proyección legible del evento; no es el evento
canónico completo.

Cada evento debe tener, como mínimo, `schemaVersion`, `eventId`, agregado y clave estable, tipo,
actor, `occurredAt`, causalidad/opcional parent y payload autosuficiente. El `eventId` debe ser
idempotente en PostgreSQL. Para merges entre branches, los Logs usan `merge=union`, un reloj
lógico y desempate determinista por `eventId`; los snapshots se regeneran después del merge.

### Direcciones de conversión

| Operación                | Dirección                                              | Semántica                                                                                                                    |
| ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Export histórico inicial | SQLite → Log → Markdown/meta                           | Convierte el estado legado y Activity existente en eventos canónicos; no debe cargar directamente PostgreSQL como autoridad. |
| Proyección normal        | Log → PostgreSQL                                       | Reduce eventos idempotentemente, actualiza checkpoint e índices derivados.                                                   |
| Reconstrucción           | Log → PostgreSQL + Markdown/meta                       | Borra/recrea proyecciones tras validar alcance y versión del Log.                                                            |
| Import explícito         | Markdown editado → comandos/eventos → Log → PostgreSQL | Nunca escribe DB directamente; rechaza cambios ambiguos y conserva historial.                                                |
| Backup PostgreSQL        | PostgreSQL → dump                                      | Es backup operativo, no una fuente para regenerar el dominio después del cutover.                                            |

Los secrets de API keys y webhooks, y las proyecciones personales de Favorites/Inbox Receipts,
permanecen fuera del Log. La migración debe tener una provisión separada para preservarlos o
rotarlos.

### Impacto en el plan PostgreSQL

- El “data pump” ya no es `SQLite → PostgreSQL`: es una importación histórica `SQLite → Log`,
  seguida de `Log → PostgreSQL`.
- Export/import y repo sync dejan de ser una réplica de PostgreSQL y pasan a ser el reducer y el
  projector del estado canónico.
- La numeración de Issues debe resolverse antes de permitir creación concurrente desde branches:
  `TEAM-123` es inmutable y no puede colisionar después de un merge.
- La respuesta GraphQL debe distinguir evento durable de proyección atrasada y definir si espera al
  projector o devuelve un estado pendiente.
- La suite debe probar replay determinista, idempotencia, merge union, conflicto del mismo campo,
  corrupción/truncado de Log y recuperación desde checkpoint.

Esta decisión reemplaza el camino de carga directa recomendado en el cuerpo anterior de esta
investigación para la arquitectura objetivo; la carga directa solo queda como herramienta de
comparación/backup durante el cutover, no como autoridad final.
