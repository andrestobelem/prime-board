# Local-first single-tenant, con API keys hasheadas y sin OAuth

El modelo de uso es un proceso local con **un** workspace, corriendo donde corre el agente.
No hay multi-tenancy, ni organizaciones, ni OAuth: la autenticación es una API key por actor
(`pb_<random>`, guardada como hash SHA-256), y el primer arranque siembra el workspace, el
team default y un actor admin con su key.

Esto es lo que permite que un agente arranque el board sin infraestructura ni cuentas, y es
la misma premisa que sostiene ADR-0001. El costo aceptado: no hay recuperación de una key
perdida (se emite una nueva), y cualquier despliegue compartido exigiría rehacer la capa de
auth entera.

## Revisión: preparación multi-workspace sin habilitación

**Fecha:** 2026-08-18

La decisión operativa se mantiene: cada proceso/DB sirve un único Workspace y no existe un
selector de Workspace. Sin embargo, el dominio deja de tratar esa cardinalidad como una razón para
mezclar el alcance en todas las APIs: se preparan seams explícitos para una futura frontera de
Workspace.

La preparación no agrega todavía una segunda fila de `workspace`, `workspace_id` a las entidades,
`workspace_memberships`, selector en GraphQL/CLI/MCP/UI ni cambios de topología. Sí exige que las
nuevas superficies reciban un `WorkspaceContext` no falsificable, que las decisiones de autorización
puedan migrar de `Actor.workspace_role` a Membership y que export/rebuild y Repository Replica
conserven la identidad y el alcance del Workspace.

La migración multi-workspace queda condicionada a un requisito explícito de servicio hosted o de
compartir una DB/proceso entre organizaciones independientes. Antes de habilitarla habrá que
resolver la identidad de Actor, alcance de API keys, unicidad de Team keys/identifiers, aislamiento
de relaciones y webhooks, y la estrategia de réplica. Esta revisión reemplaza la interpretación de
“single-tenant” como ausencia de frontera de Workspace, pero no cambia el modo operativo vigente.
