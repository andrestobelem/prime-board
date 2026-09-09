# Runbook de ensayo PRB-449

- **Ticket:** PRB-449
- **Estado:** preparado, no ejecutado.
- **Entorno:** staging local aislado. Este documento no autoriza un corte en producción.
- **Fuente:** [ADR-0019](../adr/0019-event-log-repo-source-postgresql.md) y [plan de migración](sqlite-postgresql-podman.md).

## Reglas de seguridad

1. No ejecutes este runbook si PRB-448, PRB-445, PRB-446 o PRB-447 no están en `Done` y tienen revisión independiente. Revisa también PRB-599 si forma parte del contrato del projector.
2. Usa una copia de SQLite y un volumen PostgreSQL de staging. No apuntes al proceso, al volumen ni al repositorio activos.
3. Guarda los tiempos y los reportes fuera del repositorio. Usa un directorio con permisos `0700`.
4. No imprimas variables que contengan URLs, tokens o claves. El runbook usa `PRIME_BOARD_POSTGRES_URL` solo desde el entorno del proceso.
5. No edites `.prime-board/` a mano. Export, import y regeneración deben escribir la réplica.
6. No uses `podman volume rm`. `down` detiene el contenedor, pero conserva el volumen.

Si una puerta falla, registra `NO-GO` y detén el ensayo. No reemplaces el projector por SQL manual.

## Puerta de entrada

Ejecuta las consultas desde el checkout del proyecto, sin modificarlo:

```bash
bun apps/cli/src/index.ts issue view PRB-449 --json
bun apps/cli/src/index.ts issue view PRB-448 --json
bun apps/cli/src/index.ts issue view PRB-445 --json
bun apps/cli/src/index.ts issue view PRB-446 --json
bun apps/cli/src/index.ts issue view PRB-447 --json
```

Guarda cada salida en el directorio de evidencia. Comprueba lo siguiente:

| Puerta | Condición |
| --- | --- |
| PRB-448 | `Done`, con revisión de paridad, concurrencia y restauración. |
| PRB-445 | `Done`, con event-first, projector PostgreSQL, checkpoint y lag/retry visibles. |
| PRB-446 | `Done`, con importación histórica, IDs y referencias preservados. |
| PRB-447 | `Done`, con credenciales fuera del Log y derivados reconstruibles. |
| PRB-599 | `Done` si el contrato de eventos de Issue lo exige. |
| Entorno | PostgreSQL de staging listo y una URL inyectada sin imprimirla. |

La relación nativa `PRB-449 BLOCKED_BY PRB-448` debe continuar visible. No la elimines para iniciar el ensayo.

## Preparar el directorio de evidencia

Usa un nombre nuevo para cada ensayo. El repositorio de salida debe ser diferente del checkout activo:

```bash
umask 077
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/prb-449.XXXXXX")"
EVIDENCE="$RUN_ROOT/evidence"
REPO_STAGE="$RUN_ROOT/repo"
mkdir -m 700 "$EVIDENCE" "$REPO_STAGE"
SOURCE_REPO="$PWD"
BASE_SHA="$(git rev-parse HEAD)"
printf '%s\n' "$BASE_SHA" > "$EVIDENCE/base-sha.txt"
```

Inicializa el repositorio de salida. Todavía no exportes la base activa. El export se ejecuta después del freeze y usa `SQLITE_FROZEN`:

```bash
git init "$REPO_STAGE"
git -C "$REPO_STAGE" config user.name "PRB-449 rehearsal"
git -C "$REPO_STAGE" config user.email "preflight@example.test"
git -C "$REPO_STAGE" status --porcelain=v1
```

El último comando debe no producir salida.

## Medir cada fase

Ejecuta las fases con Bash y conserva un log por fase. La función no oculta el código de salida:

```bash
set -o pipefail
measure_phase() {
  local name="$1"
  local output="$2"
  shift 2
  local log="$EVIDENCE/${name}.log"
  {
    printf 'phase=%s\n' "$name"
    printf 'started_at='
    date -u +%Y-%m-%dT%H:%M:%SZ
    if /usr/bin/time -p "$@" > "$output"; then
      code=0
    else
      code=$?
    fi
    if test -f "$output"; then
      cat "$output"
    fi
    printf 'finished_at='
    date -u +%Y-%m-%dT%H:%M:%SZ
    printf 'exit_code=%s\n' "$code"
    return "$code"
  } 2>&1 | tee "$log"
}
```

No compartas los logs sin revisar que no contengan valores sensibles.

## Freeze y backup de SQLite

1. Activa el modo de mantenimiento en el ingress de staging.
2. Rechaza mutaciones nuevas y espera las respuestas pendientes.
3. Registra el inicio, detén el proceso SQLite con el supervisor del entorno y conserva el PID.
4. Registra el fin y verifica que el proceso no acepte nuevas mutaciones.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVIDENCE/freeze-start.txt"
# Activa el mantenimiento, rechaza mutaciones y detén el proceso SQLite aquí.
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVIDENCE/freeze-end.txt"
```

Después crea una copia verificada. El runtime usa `VACUUM INTO`, comprueba integridad y escribe un manifest junto al backup:

```bash
test -n "${PRIME_BOARD_DB:-}"
SQLITE_FROZEN="$RUN_ROOT/sqlite-frozen.sqlite"
measure_phase sqlite-freeze "$EVIDENCE/sqlite-backup-output.txt" \
  bun packages/prime-board-runtime/src/cli.ts \
  --project "$SOURCE_REPO" --db "$PRIME_BOARD_DB" --backup "$SQLITE_FROZEN"
test -f "$SQLITE_FROZEN" -a -f "$SQLITE_FROZEN.json"
shasum -a 256 "$SQLITE_FROZEN" > "$EVIDENCE/sqlite-frozen.sha256"
```

Registra `databaseSha256`, `databaseBytes`, `schemaVersion`, `journalMode`, `sourceWalPresent` y `sourceShmPresent` del manifest. El backup debe estar fuera de `.prime-board/` y tener permisos privados.

Exporta la copia congelada. El script genera los archivos de la réplica y no lee la base activa:

```bash
PRIME_BOARD_PERSISTENCE=sqlite \
PRIME_BOARD_DB="$SQLITE_FROZEN" \
bun run --cwd apps/server export --out "$REPO_STAGE" \
  > "$EVIDENCE/sqlite-export.log" 2>&1

git -C "$REPO_STAGE" add -- .prime-board
git -C "$REPO_STAGE" commit -m "chore(migration): prepara export de staging"
git -C "$REPO_STAGE" status --porcelain=v1
```

El último comando debe no producir salida. Si el export usa Documents históricos, pasa un archivo externo mediante `--documents-archive`. Ese archivo queda fuera de `REPO_STAGE` y no entra en Git.

## Importar el histórico y hacer commit del Log

Esta fase requiere el comando de PRB-446. El `dry-run` no escribe el Log:

```bash
measure_phase import-dry-run "$EVIDENCE/import-dry-run.json" \
  bun run --cwd apps/server import:sqlite-events \
  --from "$SQLITE_FROZEN" --out "$REPO_STAGE" \
  --workspace-id "$WORKSPACE_ID" --batch-size 1000 --dry-run --json
```

Aprueba los contadores antes de continuar. `orphaned`, `ambiguous` y `rejected` deben ser cero o tener una aprobación explícita. `outOfScope` debe coincidir con el alcance elegido. `excluded` debe incluir solo material personal o sensible previsto.

Aplica el mismo plan y registra el resultado:

```bash
measure_phase import-apply "$EVIDENCE/import-apply.json" \
  bun run --cwd apps/server import:sqlite-events \
  --from "$SQLITE_FROZEN" --out "$REPO_STAGE" \
  --workspace-id "$WORKSPACE_ID" --batch-size 1000 --json

git -C "$REPO_STAGE" diff --check
test "$(git -C "$REPO_STAGE" diff --name-only)" = ".prime-board/log/events.jsonl"
git -C "$REPO_STAGE" add -- .prime-board/log/events.jsonl
test "$(git -C "$REPO_STAGE" diff --cached --name-only)" = ".prime-board/log/events.jsonl"
measure_phase log-commit "$EVIDENCE/log-commit-output.txt" \
  git -C "$REPO_STAGE" commit -m "chore(migration): importa eventos históricos"
git -C "$REPO_STAGE" rev-parse HEAD > "$EVIDENCE/log-commit-sha.txt"
```

Si aparece otro archivo, detén el ensayo. No uses `git add -A`.

## Preparar PostgreSQL de staging

Usa nombres nuevos para el contenedor, la red, el volumen y el secreto. `up` solicita la contraseña sin mostrarla o la lee desde un canal de secretos del runner. No la pases como argumento:

```bash
export PB_PG_CONTAINER=prb449-postgres
export PB_PG_NETWORK=prb449-network
export PB_PG_VOLUME=prb449-pgdata
export PB_PG_SECRET=prb449-pg-password
export PB_PG_DB=primeboard
export PB_PG_USER=primeboard
export PB_PG_PORT=55449

scripts/postgres-dev.sh up
scripts/postgres-dev.sh status
scripts/postgres-dev.sh check
```

`status` debe mostrar el contenedor en ejecución y `check` debe devolver `PostgreSQL query check: OK`. Si el volumen o el secreto ya existían, detén el ensayo y usa nombres nuevos. No reutilices un entorno que pueda contener datos ajenos.

## Replay y regeneración

PRB-445 debe proporcionar el caller productivo que conecta `replayPostgresEvents` con `applyCanonicalEvent`. El estado auditado no tenía ese caller. No inventes otro camino ni escribas filas de negocio con `psql`.

Cuando la puerta esté abierta, ejecuta el replay contra el PostgreSQL limpio de staging. Inyecta la URL desde el gestor de secretos sin mostrarla:

```bash
test -n "${PRIME_BOARD_POSTGRES_URL:-}"
export SOURCE_REPO REPO_STAGE PRIME_BOARD_POSTGRES_URL

cat > "$RUN_ROOT/replay.ts" <<'EOF'
const sourceRepo = process.env.SOURCE_REPO;
if (!sourceRepo) throw new Error("SOURCE_REPO is required");
const { createPostgresPersistence } = await import(
  `${sourceRepo}/apps/server/src/db/postgres/persistence.ts`,
);
const { migratePostgres } = await import(`${sourceRepo}/apps/server/src/db/postgres/migrator.ts`);
const { applyCanonicalEvent } = await import(
  `${sourceRepo}/apps/server/src/export/postgres-projector.ts`,
);
const { replayPostgresEvents } = await import(`${sourceRepo}/apps/server/src/export/projector.ts`);
const sql = new Bun.SQL({ url: process.env.PRIME_BOARD_POSTGRES_URL });
await migratePostgres(sql);
const persistence = createPostgresPersistence(sql);
try {
  const result = await replayPostgresEvents(applyCanonicalEvent, {
    rootDir: process.env.REPO_STAGE,
    stream: "canonical",
    persistence,
  });
  console.log(JSON.stringify({
    status: result.status,
    applied: result.applied,
    skipped: result.skipped,
    lag: result.lag,
    checkpoint: result.checkpoint,
  }));
  if (result.failed) process.exitCode = 1;
} finally {
  await persistence.close();
}
EOF

measure_phase replay-fresh "$EVIDENCE/replay-fresh.json" bun "$RUN_ROOT/replay.ts"
measure_phase replay-incremental "$EVIDENCE/replay-incremental.json" bun "$RUN_ROOT/replay.ts"
```

Exige `status=completed` y `lag=0`. Guarda el `checkpoint` y el número de eventos. Ejecuta el mismo comando una segunda vez con `replay-incremental.json`. La segunda ejecución debe aplicar cero eventos, omitir el stream ya checkpointado y conservar `lag=0`.

Luego regenera Markdown y metadata con el reducer de PRB-445. La regeneración debe leer solo el Log:

```bash
measure_phase projections "$EVIDENCE/projections.json" bun -e '
  const { regenerateCanonicalProjections } = await import(`${process.env.SOURCE_REPO}/apps/server/src/export/canonical-projection.ts`);
  const result = regenerateCanonicalProjections(process.env.REPO_STAGE);
  console.log(JSON.stringify(result));
'

git -C "$REPO_STAGE" diff --check
git -C "$REPO_STAGE" add -- .prime-board/issues .prime-board/meta
git -C "$REPO_STAGE" commit -m "chore(migration): regenera proyecciones canónicas"
```

## Validar paridad y arranque

Compara la base congelada con el PostgreSQL proyectado. Los exports se generan con los scripts, no con una edición del output:

```bash
SQLITE_EXPORT="$RUN_ROOT/sqlite-export-check"
PG_EXPORT="$RUN_ROOT/pg-export-check"

PRIME_BOARD_PERSISTENCE=sqlite PRIME_BOARD_DB="$SQLITE_FROZEN" \
bun run --cwd apps/server export --out "$SQLITE_EXPORT" \
  > "$EVIDENCE/export-sqlite-check.log" 2>&1

PRIME_BOARD_PERSISTENCE=postgres PRIME_BOARD_POSTGRES_URL="$PRIME_BOARD_POSTGRES_URL" \
bun run --cwd apps/server export --out "$PG_EXPORT" \
  > "$EVIDENCE/export-pg-check.log" 2>&1
```

Usa la prueba de paridad de PRB-448 para comparar conteos, IDs, referencias, foreign keys, timestamps, GraphQL, export, búsqueda, snapshots y metadata. No apruebes una diferencia por ignorarla. Registra cada excepción y su motivo.

Ejecuta además la suite y el build desde el checkout que contiene PRB-445 y PRB-446:

```bash
(cd apps/server && bun test --max-concurrency=1 src/export)
bun run typecheck
bun run build
```

Inicia el server solo en el puerto y el PostgreSQL de staging:

```bash
PRIME_BOARD_AUTH_MODE=local \
PRIME_BOARD_PERSISTENCE=postgres \
PRIME_BOARD_POSTGRES_URL="$PRIME_BOARD_POSTGRES_URL" \
PRIME_BOARD_REPO="$REPO_STAGE" \
PRIME_BOARD_PORT="$STAGING_PORT" \
bun run --cwd apps/server start > "$EVIDENCE/server.log" 2>&1 &
SERVER_PID=$!
curl --fail --silent "http://127.0.0.1:$STAGING_PORT/health" \
  > "$EVIDENCE/health.json"
```

Ejecuta las mutaciones de prueba del harness de PRB-448. Comprueba que cada mutación sigue `append → commit Git → project → checkpoint`, que el lag queda visible y que un fallo no responde éxito. Detén el proceso de staging al terminar:

```bash
kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
```

## Ensayar rollback sin destruir PostgreSQL

Este bloque solo usa staging. No lo ejecutes contra una instancia productiva.

1. Bloquea mutaciones y detén el server PostgreSQL de staging.
2. Guarda un `pg_dump` y el último checkpoint antes de volver a SQLite.
3. Captura la identidad del volumen con `podman volume inspect`. No lo borres.
4. Inicia un server SQLite en otro puerto con `SQLITE_FROZEN` como `PRIME_BOARD_DB`.
5. Comprueba lecturas, export y health. Mantén SQLite sin escrituras durante la observación.
6. Comprueba que el Log conserva todos los `eventId` publicados y que el dump PostgreSQL es legible.
7. Captura de nuevo la identidad del volumen. Debe coincidir.

```bash
PB_PG_BACKUP="$EVIDENCE/pg-before-rollback.dump" \
scripts/postgres-dev.sh backup > "$EVIDENCE/pg-backup.log" 2>&1
podman volume inspect "$PB_PG_VOLUME" --format '{{.Name}} {{.Mountpoint}}' \
  > "$EVIDENCE/pg-volume-before.txt"

PRIME_BOARD_AUTH_MODE=local \
PRIME_BOARD_PERSISTENCE=sqlite \
PRIME_BOARD_DB="$SQLITE_FROZEN" \
PRIME_BOARD_PORT="$ROLLBACK_PORT" \
bun run --cwd apps/server start > "$EVIDENCE/sqlite-rollback.log" 2>&1 &
ROLLBACK_PID=$!
curl --fail --silent "http://127.0.0.1:$ROLLBACK_PORT/health" \
  > "$EVIDENCE/rollback-health.json"
kill -TERM "$ROLLBACK_PID"
wait "$ROLLBACK_PID"

podman volume inspect "$PB_PG_VOLUME" --format '{{.Name}} {{.Mountpoint}}' \
  > "$EVIDENCE/pg-volume-after.txt"
diff -u "$EVIDENCE/pg-volume-before.txt" "$EVIDENCE/pg-volume-after.txt"
```

Un rollback posterior a escrituras PG no es lossless por defecto. Si hubo eventos después del freeze, no declares `GO` hasta demostrar que cada uno está en el Log y que existe un plan de reconciliación. El SQLite congelado no los contiene.

## Decisión go/no-go

Completa esta tabla en `EVIDENCE/decision.md` sin incluir credenciales:

| Criterio | Evidencia | Resultado |
| --- | --- | --- |
| Freeze y backup consistente | `freeze-start.txt`, `freeze-end.txt`, `sqlite-frozen.sqlite.json` y SHA-256 |  |
| Dry-run y aplicación histórica | `import-dry-run.json`, `import-apply.json` |  |
| Commit aislado del Log | `log-commit-sha.txt`, `git diff --check` |  |
| Replay fresh e incremental | `replay-fresh.json`, `replay-incremental.json` |  |
| Paridad y foreign keys | reporte de PRB-448 |  |
| Arranque y health | `health.json`, `server.log` |  |
| Lag y retry | resultados del projector |  |
| Rollback | dump, volumen before/after, health |  |
| Runbook reproducible | revisión de comandos y permisos |  |

Declara `GO` solo si todos los criterios pasan, dos personas revisan la evidencia y la ventana está aprobada. Declara `NO-GO` si hay un blocker abierto, un contador no explicado, una diferencia de paridad, lag distinto de cero, un fallo sin retry, una credencial en los reportes o un rollback sin reconciliación.

La decisión inicial de este documento es `NO-GO`: al prepararlo, PRB-448, PRB-445, PRB-446 y PRB-447 aún no constituían una cadena cerrada y no se ejecutó ningún cutover ni rollback.
