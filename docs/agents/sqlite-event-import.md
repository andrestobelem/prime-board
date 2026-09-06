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
  fila aporta `issue_id`, el evento agrega `payload.issue_id` como referencia estable.
  `aggregateKey` conserva el identifier para lectores legacy; un cambio de Team o
  número no cambia la identidad cuando ambos eventos tienen el `issue_id` estable.
- Las demás entidades compartidas se representan como `snapshot_imported`. El
  payload contiene la fila completa y `sourceTable`/`sourceId`, por lo que un
  projector futuro puede reconstruirla sin consultar SQLite.
- `workspace_id` y las referencias se validan antes de escribir. El reporte
  separa filas fuera de alcance, huérfanas, ambiguas, rechazadas y duplicadas.
  Una referencia a una tabla o fila ausente es huérfana.
- Una fuente con un solo Workspace mantiene compatibilidad con filas legacy
  anteriores a `workspace_id`: el ID único se usa como alcance cuando la fuente
  no puede asignar otro. Una fuente multi-Workspace requiere selector y alcance
  explícitos; no se infiere un `NULL`.
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
