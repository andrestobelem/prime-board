---
status: accepted — arquitectura objetivo para PostgreSQL; pendiente de implementación
---

# Event Log del repositorio como fuente de verdad con PostgreSQL

La migración a PostgreSQL no convertirá la base en la fuente canónica. En la topología PostgreSQL objetivo, el repositorio versionado será la autoridad del estado compartido. `.prime-board/log/*.jsonl` contendrá eventos de dominio append-only; los archivos Markdown, `meta/*.json` y PostgreSQL serán proyecciones reconstruibles. Esta decisión conserva la colaboración y la revisión por Git. También evita confundir el CDC del WAL de PostgreSQL con la autoridad del dominio.

## Protocolo de escritura

Una mutación seguirá este orden:

1. Validar el comando y generar un evento con `eventId`, versión de schema, agregado, tipo, Actor, momento, causación y payload autosuficiente.
2. Agregar el evento al Log canónico y hacer commit Git de la operación lógica.
3. Aplicar el evento de forma idempotente al proyector PostgreSQL.
4. Regenerar el Issue Markdown y la metadata derivada cuando corresponda.

Si el proyector falla, el evento del repositorio sigue siendo válido y queda pendiente de reintento o replay. La API no debe informar que una proyección está completa. El proyector guarda checkpoints y puede reconstruir PostgreSQL desde cero.

## Alcance

Repository Source contiene el estado compartido: Workspace, Teams, Workflow States, Issues, Comments, Relations, Projects, Cycles, Initiatives, Reviews y sus eventos. Favorites, Inbox Receipts, API keys y secretos de webhooks quedan fuera porque son estado personal o material sensible. El importador Markdown solo emite eventos explícitos. Nunca escribe directamente en PostgreSQL.

## Consecuencias

- El data pump de SQLite se convierte en una importación histórica `SQLite → Log`, seguida de `Log → PostgreSQL`. No hay carga directa como autoridad final.
- El equipo no mergea snapshots Markdown a mano. Después de un merge de Logs, ejecuta el reducer y los regenera.
- Los Logs usan merges `union` y resolución determinista por reloj lógico/eventId. La numeración de Issues necesita coordinación o una regla explícita antes de aceptar creación concurrente en branches.
- PostgreSQL es un índice operativo. No debe recibir escrituras de negocio fuera del proyector.
- ADR-0004 sigue describiendo el runtime SQLite vigente hasta el cutover. Esta ADR define la arquitectura PostgreSQL objetivo y su transición.
