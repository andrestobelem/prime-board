# Autenticación PostgreSQL por Membership

- **Ticket:** PRB-513
- **Migración:** `apps/server/src/db/postgres/0007_workspace_auth.sql`

## Contrato

`resolvePostgresAuth` acepta una credencial solo cuando la misma resolución reúne:

1. Una API key válida y no revocada.
2. Un grant de esa key para el Workspace.
3. Un selector que coincide con ese Workspace, o un grant por defecto inequívoco.
4. Una `workspace_memberships` activa para el Actor de la key en ese Workspace.

Una key sin grant, una Membership `suspended` o `left`, un Actor distinto o un
Workspace no concedido no autentican. El selector no es una prueba de acceso.

El `workspace_role` y el `status` del `AuthContext` y del Actor autenticado son
los de la Membership efectiva. Las columnas globales de `actors` solo conservan
la identidad y compatibilidad histórica.

## Migración y límite de alcance

La migración crea `workspace_memberships` y `api_key_workspaces`, hace backfill
del Workspace singleton existente y conserva los hashes de las keys. Los
triggers solo crean la Membership y el grant iniciales de nuevos Actors y keys.
No implementan cambios de estado ni revocación.

PRB-475 debe actualizar la Membership y los grants del Workspace objetivo en la
misma transacción de cada operación de lifecycle. No debe usar las columnas
globales de `actors` como autoridad de acceso. Invitaciones, suspensión,
reactivación, salida, revocación y la regla del último admin quedan fuera de
PRB-513.
