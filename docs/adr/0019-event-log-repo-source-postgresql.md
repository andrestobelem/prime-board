---
status: aceptado — arquitectura objetivo para PostgreSQL; implementación pendiente
---

# ADR-0019: Event Log del repositorio como fuente de verdad con PostgreSQL

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

### Eventos de importación histórica

Un importador de una captura histórica puede emitir `type: snapshot_imported`. Este tipo no representa una nueva acción de negocio. Representa el estado observado de una fila que no tiene una secuencia de eventos original. Su `payload` conserva la fila y la metadata de origen; el proyector no crea una fila de `Activity` para este tipo.

Las relaciones importadas pueden usar agregados auxiliares (`project_team`, `issue_label`, `issue_relation`, `initiative_project`, `initiative_team`, `issue_subscriber` y `workspace_membership`). Su clave de idempotencia es el ID de la fila o la tupla estable de sus extremos. El proyector resuelve estas relaciones después de asegurar sus agregados padre. Las mutaciones online siguen usando eventos del agregado padre con payload completo; no deben cambiar a `snapshot_imported`.

## Exclusión aceptada para PRB-440

PRB-440 no implementa auditoría durable para `Initiative` ni para `Project Update`. El
modelo actual de `Activity` es issue-only y las operaciones de estas entidades no
producen un event log PostgreSQL completo. La implementación y la validación de ese
log quedan explícitamente diferidas a PRB-445/PRB-446. El smoke de PRB-440 valida
persistencia, autorización, relaciones, cascadas y exportación, pero no presenta esa
auditoría como completada.

## Consecuencias

- El data pump de SQLite se convierte en una importación histórica `SQLite → Log`, seguida de `Log → PostgreSQL`. No hay carga directa como autoridad final.
- El equipo no mergea snapshots Markdown a mano. Después de un merge de Logs, ejecuta el reducer y los regenera.
- Los Logs usan merges `union` y resolución determinista por reloj lógico/eventId. La numeración de Issues necesita coordinación o una regla explícita antes de aceptar creación concurrente en branches.
- PostgreSQL es un índice operativo. No debe recibir escrituras de negocio fuera del proyector.
- ADR-0004 sigue describiendo el runtime SQLite vigente hasta el cutover. Esta ADR define la arquitectura PostgreSQL objetivo y su transición.
