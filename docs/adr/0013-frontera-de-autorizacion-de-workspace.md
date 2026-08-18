# ADR-0013: Frontera futura de autorización de Workspace

- Estado: aceptado para preparación; habilitación pendiente
- Fecha: 2026-08-18

## Contexto

La instalación actual autentica una API key contra un Actor y guarda `workspace_role` en
`actors`. Esto es suficiente mientras cada proceso/DB tiene un único Workspace, pero no define
cómo se evita que una credencial o un bypass administrativo atraviese la frontera cuando exista
más de uno.

Agregar `workspaceId` como input no resuelve el problema: el caller podría falsificarlo y los
resolvers seguirían sin una prueba de pertenencia. La frontera debe resolverse antes de ejecutar
la operación y acompañar cada lookup, mutación, evento y réplica mediante `WorkspaceContext`.

## Decisión

Se mantienen estas reglas de transición:

1. El modo operativo sigue siendo un Workspace por proceso/DB. No se agrega selector, creación de
   Workspaces ni una migración de memberships todavía.
2. La autenticación resuelve primero la identidad del Actor y luego el Workspace efectivo desde
   una credencial/membership confiable. Un Workspace recibido por GraphQL, CLI, MCP o UI nunca es
   autoridad por sí mismo.
3. `Actor.workspace_role` continúa siendo la compatibilidad single-workspace y no se amplían sus
   permisos. Antes de habilitar un segundo Workspace, el rol deberá vivir en una relación
   `Workspace Membership` o en una estructura equivalente.
4. El alcance de una API key, la identidad global o por Workspace del Actor y la topología de
   selección quedan deliberadamente abiertos hasta resolver el requisito de producto. Las
   interfaces deben permitir ambas alternativas sin acoplar los resolvers a una columna global.
5. La revocación y administración de keys deberán poder limitarse al Workspace autorizado. Los
   webhooks y eventos se despacharán únicamente dentro del Workspace efectivo.

## Contrato de preparación

- `WorkspaceContext` es no falsificable por inputs de la operación.
- Los guards de datos validan referencias directas y relaciones contra ese contexto.
- Las nuevas tablas o interfaces de auth deben ser aditivas y conservar la identidad actual del
  Workspace, Actors y API keys durante el backfill.
- No se puede habilitar el segundo Workspace hasta contar con tests negativos para key, rol,
  webhook, export/rebuild, réplica y todos los clientes.

## Consecuencias

La implementación puede preparar tipos, adaptadores y tests sin romper la instalación actual,
pero no debe inventar una política de selección. Una futura decisión de producto deberá elegir
explícitamente entre Actor global o por Workspace, keys por Workspace o con scopes múltiples, y
los flujos de invitación/suspensión/transferencia de roles.
