---
status: accepted — arquitectura objetivo para PostgreSQL; pendiente de implementación
---

# Event log del repositorio como fuente de verdad con PostgreSQL

La migración a PostgreSQL no convertirá la base en la fuente canónica: para la topología PostgreSQL objetivo, el repositorio versionado será la autoridad del estado compartido. El `.prime-board/log/*.jsonl` contendrá eventos de dominio append-only; los archivos Markdown, `meta/*.json` y PostgreSQL serán proyecciones reconstruibles. Esta decisión conserva la colaboración y revisión por Git, y evita confundir CDC del WAL de PostgreSQL con la autoridad del dominio.

## Protocolo de escritura

Una mutación seguirá este orden:

1. Validar el comando y generar un evento con `eventId`, versión de esquema, agregado, tipo, actor, momento, causación y payload autosuficiente.
2. Append al Log canónico y commit Git de la operación lógica.
3. Aplicar el evento de forma idempotente al proyector PostgreSQL.
4. Regenerar el Issue Markdown y metadata derivada cuando corresponda.

Si el proyector falla, el evento del repositorio sigue siendo válido y queda pendiente de
reintento/replay; la API no reporta una proyección completa como si hubiera terminado. El
proyector guarda checkpoints y puede reconstruir PostgreSQL desde cero.

## Alcance

El Repository Source contiene el estado compartido: Workspace, Teams, Workflow States, Issues,
Comments, Relations, Projects, Cycles, Initiatives, Reviews y sus eventos. Favoritos, Inbox
Receipts, API keys y secretos de webhooks quedan fuera por ser estado personal o material sensible.
El importador Markdown solo emite eventos explícitos; nunca escribe directamente en PostgreSQL.

## Consecuencias

- El data pump de SQLite se convierte en una importación histórica `SQLite → Log`, seguida de
  `Log → PostgreSQL`; no hay carga directa como autoridad final.
- Los snapshots Markdown no se mergean manualmente: después de un merge de Logs se ejecuta el
  reducer y se regeneran.
- Los Logs usan merges `union` y resolución determinista por reloj lógico/eventId; la numeración
  de Issues necesita coordinación o una regla explícita antes de aceptar creación concurrente en
  branches.
- PostgreSQL es un índice operativo y no debe recibir escrituras de negocio fuera del proyector.
- ADR-0004 continúa describiendo el runtime SQLite vigente hasta el cutover; esta ADR define la
  arquitectura objetivo PostgreSQL y su transición.
