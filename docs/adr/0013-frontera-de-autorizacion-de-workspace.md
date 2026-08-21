# ADR-0013: Frontera futura de autorización de Workspace

- Estado: transición supersedida por ADR-0017; preparación vigente, habilitación pendiente
- Fecha: 2026-08-18

> ADR-0017 (2026-08-19) fija la topología de varios Workspaces en una misma DB/proceso, un Actor global y API keys globales con grants. Este ADR conserva las invariantes de la frontera y el modo single-workspace actual. Sus alternativas abiertas de identidad, keys y topología ya no son decisiones vigentes.

## Contexto

La instalación actual autentica una API key contra un Actor y guarda `workspace_role` en `actors`. Esto basta mientras cada proceso/DB tiene un único Workspace, pero no define cómo impedir que una credencial o un bypass administrativo atraviese la frontera cuando exista más de uno.

Agregar `workspaceId` como input no resuelve el problema. El caller podría falsificarlo y los resolvers seguirían sin una prueba de pertenencia. El sistema debe resolver la frontera antes de ejecutar la operación y acompañar cada lookup, mutación, evento y réplica mediante `WorkspaceContext`.

## Decisión

Se mantienen estas reglas de transición:

1. El modo operativo sigue siendo un Workspace por proceso/DB. El sistema todavía no agrega selector, creación de Workspaces ni migración de Memberships.
2. La autenticación resuelve primero la identidad del Actor y luego el Workspace efectivo desde una credencial o Membership confiable. Un Workspace recibido por GraphQL, CLI, MCP o UI nunca tiene autoridad por sí mismo.
3. `Actor.workspace_role` mantiene la compatibilidad single-workspace y sus permisos no se amplían. Antes de habilitar un segundo Workspace, el rol debe vivir en una `Workspace Membership` o estructura equivalente.
4. ADR-0017 decide una identidad global de Actor, API keys globales con grants explícitos por Workspace y selección validada por credencial, grant y Membership. Las interfaces deben conservar el seam de transición hasta que PRB-413 implemente esa decisión. Si la complejidad exige keys de un solo Workspace, el equipo debe registrarlo explícitamente allí antes de cambiar el esquema.
5. La revocación y la administración de keys deben limitarse al Workspace autorizado. El sistema despacha webhooks y eventos solo dentro del Workspace efectivo.

## Contrato de preparación

- `WorkspaceContext` no puede falsificarse mediante inputs de la operación.
- Los guards de datos validan las referencias directas y las relaciones contra ese contexto.
- Las nuevas tablas o interfaces de auth deben ser aditivas y conservar durante el backfill la identidad actual del Workspace, los Actors y las API keys.
- El equipo no puede habilitar el segundo Workspace hasta contar con tests negativos para key, rol, webhook, export/rebuild, réplica y todos los clientes.

## Consecuencias

La implementación puede preparar tipos, adaptadores y tests sin romper la instalación actual, pero ADR-0017 ya fija la política de selección y el modelo de identidad. PRB-413 debe implementar el modelo o, si encuentra un bloqueo técnico documentado, reemplazar explícitamente el modelo de keys globales con grants antes de cambiar el esquema. También debe cubrir invitación, suspensión y transferencia de roles.
