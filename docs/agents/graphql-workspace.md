# Contrato GraphQL de Workspace

## Listado

`workspaces` y `viewer.workspaces` devuelven los Workspaces concedidos al Actor mediante la API key y una `Workspace Membership` activa. Cada elemento incluye:

- `id`, `name`, `urlKey` y `createdAt` del Workspace;
- `role` y `status` de la Membership;
- `isDefault` del grant de la API key.

El orden es estable por `createdAt` e `id`. Una Membership sin grant, una Membership no activa o un Workspace ajeno no aparece.

## Contexto efectivo

La selección se transporta fuera de GraphQL mediante `X-Workspace-ID`. El servidor valida el ID contra el grant de la API key y la Membership activa antes de construir `WorkspaceContext`. `workspace` y `workspaceUpdate` no reciben `workspaceId` como input.

Sin header, una instalación con un solo Workspace conserva el fallback legacy. También se usa el único grant activo o el grant default. Si no existe una selección inequívoca, la operación devuelve `WORKSPACE_REQUIRED` antes de ejecutar el resolver.

En modo `api-key`, un selector inexistente o no concedido devuelve `UNAUTHORIZED` sin revelar
si el Workspace existe. Una request sin API key también devuelve `UNAUTHORIZED`. En modo `local`,
la selección local puede operar sin API key.

## Lifecycle

`workspaceCreate(input: { name, urlKey })` exige un Actor admin y crea en una transacción:

1. el Workspace;
2. la Membership admin inicial;
3. un Team default;
4. los Workflow States default;
5. la Membership owner del Team y los grants del Actor admin.

`urlKey` es estable y único. En el bootstrap usa minúsculas, números y guiones. La creación no copia Teams, Issues, Projects, Labels ni otros recursos del Workspace activo. `workspaceUpdate` solo cambia el nombre del contexto efectivo.

## Límites actuales

El CLI y la UI ya permiten seleccionar un Workspace. El CLI usa `pb workspace list` y `pb workspace use <ID|URLKEY|NAME>`. La UI muestra el switcher cuando el servidor expone el contrato `workspaces`.

El ciclo completo de Memberships e invitaciones aún requiere trabajo adicional. La ruta PostgreSQL de creación multi-Workspace queda pendiente de la migración de Auth y persistencia.
