# Importación del histórico SQLite

`import:sqlite-events` convierte una copia consistente de SQLite en eventos del
Repository Source. El comando no abre PostgreSQL ni escribe en la base fuente.

## Uso

```bash
bun run import:sqlite-events \
  --from /ruta/board.sqlite \
  --out /ruta/repository \
  --dry-run \
  --json

# Aplicar después de revisar el reporte
bun run import:sqlite-events --from /ruta/board.sqlite --out /ruta/repository --json
```

Una fuente con varios Workspaces exige `--workspace-id`. `--batch-size` limita
el tamaño de cada append. Si el proceso se interrumpe, se puede repetir: el
`eventId` estable clasifica los eventos ya escritos como `duplicates`.

## Conversión

- Las filas de `activity` conservan su ID, tipo, actor, fecha y payload. Cuando la
  fila aporta `issue_id`, el evento usa ese ID inmutable como `aggregateKey` y conserva
  también `payload.issue_id` y `payload.issue_identifier`. El identificador legible
  puede cambiar si se renombra el Team o se renumera la Issue, sin cambiar el agregado.
  Los callers legacy que no aportan `issue_id` conservan su `aggregateKey` anterior.
- Las demás entidades compartidas se representan como `snapshot_imported`. El
  payload contiene la fila completa y `sourceTable`/`sourceId`, por lo que un
  projector futuro puede reconstruirla sin consultar SQLite.
- `workspace_id` y las referencias se validan antes de escribir. El reporte
  separa filas fuera de alcance, huérfanas, ambiguas, rechazadas y duplicadas.
  Una referencia a una tabla o fila ausente es huérfana. Una referencia a un Actor
  solo es válida cuando una Membership de Workspace demuestra su pertenencia, salvo
  el fallback legacy descrito abajo. Si `workspace_memberships` está presente pero
  su metadata o sus filas son incompletas, ambiguas o inválidas, ninguna referencia
  a Actor usa el `workspace_id` directo como sustituto: la fila queda ambigua,
  huérfana o rechazada y no se escribe.
- La tabla `workspace` es la autoridad cuando existe. Un único ID permite conservar
  el alcance de una fuente singleton; varios IDs requieren `--workspace-id`. Sin
  tabla `workspace`, una tabla `workspace_memberships` completa puede demostrar los
  IDs: un solo ID se infiere y varios IDs requieren selector. El selector debe
  coincidir con un ID demostrado por `workspace` o por Memberships; no autoriza un
  Workspace arbitrario cuando la metadata scoped es incompleta.
- El fallback singleton legacy solo aplica cuando no existe la tabla `workspace`, no
  existe `workspace_memberships` y ninguna tabla compartida conserva una columna
  `workspace_id`. En ese caso las filas previas al scope se emiten sin `workspaceId`,
  salvo que el caller aporte un selector explícito: ese ID solo es una instrucción de
  alcance y no una identidad demostrada por SQLite. Una fuente multi-Workspace no
  usa un `NULL` como alcance ni confía solo en `workspace_id` para autorizar un Actor.
- El adaptador de Activity de bajo nivel (`importSqliteActivity`) comparte esta
  frontera para una Membership presente e incompleta. Conserva su contrato legacy
  para fuentes sin tabla Membership: una fila legacy puede seguir usando el Workspace
  seleccionado por el caller. El importador completo aplica la misma
  decisión a Activity y a todas las familias de snapshots.
- `api_keys`, sus grants, hashes y scopes, invitaciones, webhooks, Documents retirados,
  Favorites e Inbox Receipts se cuentan como `excluded` y no se leen como filas
  de eventos. Los nombres y campos sensibles (incluidos `hash`, `token_hash`,
  `grant` e `invitation` y sus variantes) se rechazan sin escribir el payload.

El importador solo escribe `.prime-board/log/events.jsonl`. La reconstrucción
posterior debe ejecutarse con un projector del Log; el importador no escribe
PostgreSQL. El contrato para proyectar `snapshot_imported` y aggregates
standalone todavía no está definido. Esa brecha requiere coordinación con
PRB-445/PRB-599; este importador no inventa nombres de tablas, reducers ni
contratos PostgreSQL.
