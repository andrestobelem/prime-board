# Local-first single-tenant, con API keys hasheadas y sin OAuth

> **Estado actual (2026-08-19):** ADR-0017 prepara varios Workspaces aislados en una misma DB/proceso. Este ADR describe el modo operativo single-workspace vigente hasta completar PRB-411–420. ADR-0017 define la topología objetivo y la autorización futura.

El producto funciona como un proceso local con **un** Workspace, en la máquina donde opera el agente. No hay multi-tenancy, organizaciones ni OAuth. Cada Actor se autentica con una API key (`pb_<random>`) almacenada como hash SHA-256. El primer arranque crea el Workspace, el Team default y un Actor admin con su key.

Este diseño permite que un agente inicie el board sin infraestructura ni cuentas. También mantiene la premisa de ADR-0001. El costo aceptado es que no existe recuperación de una key perdida: el sistema emite una nueva. Un despliegue compartido exigiría rehacer toda la capa de auth.

## Revisión: preparación multi-workspace sin habilitación

**Fecha:** 2026-08-18

La decisión operativa permanece: cada proceso/DB sirve un único Workspace y no existe un selector de Workspace. El dominio, sin embargo, ya no trata esa cardinalidad como razón para mezclar el alcance en todas las APIs. Las nuevas superficies reciben seams explícitos para una futura frontera de Workspace.

La preparación todavía no agrega una segunda fila de `workspace`, `workspace_id` a las entidades, `workspace_memberships`, selector en GraphQL/CLI/MCP/UI ni cambios de topología. Sí exige que las nuevas superficies reciban un `WorkspaceContext` no falsificable, que las decisiones de autorización puedan migrar de `Actor.workspace_role` a Membership y que export/rebuild y Repository Replica conserven la identidad y el alcance del Workspace.

La habilitación multi-workspace depende de completar la puerta de ADR-0017 y PRB-420. Prime-board ya decidió compartir una DB/proceso entre Workspaces. Antes de habilitarlo, el equipo debe resolver la identidad de Actor, el alcance de API keys, la unicidad de Team keys/Identifiers, el aislamiento de relaciones y webhooks y la estrategia de réplica. Esta revisión reemplaza la interpretación de “single-tenant” como ausencia de frontera de Workspace, pero no cambia el modo operativo vigente.
