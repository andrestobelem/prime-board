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

- Las filas de `activity` conservan su ID, tipo, actor, fecha y payload.
- Las demás entidades compartidas se representan como `snapshot_imported`. El
  payload contiene la fila completa y `sourceTable`/`sourceId`, por lo que un
  projector puede reconstruirla sin consultar SQLite.
- `workspace_id` y las referencias se validan antes de escribir. El reporte
  separa filas fuera de alcance, huérfanas, ambiguas, rechazadas y duplicadas.
- `api_keys`, sus grants, hashes y scopes, invitaciones, webhooks, Documents retirados,
  Favorites e Inbox Receipts se cuentan como `excluded` y no se leen como filas
  de eventos.

El importador solo escribe `.prime-board/log/events.jsonl`. La reconstrucción
posterior debe ejecutarse con un projector del Log; el importador no escribe
PostgreSQL. El adapter de PostgreSQL debe tratar `snapshot_imported` como una
proyección de estado, sin crear una actividad histórica, y aceptar los aggregates
de relaciones para reconstruirlos desde el payload. La ampliación del adapter se
coordina en PRB-599.
