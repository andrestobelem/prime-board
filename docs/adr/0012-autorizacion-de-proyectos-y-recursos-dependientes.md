# ADR-0012: Autorización de Projects y recursos dependientes

- **Estado:** aceptado
- **Fecha:** 2026-08-17
- **Contexto:** PRB-272

## Contexto

Los Projects pueden pertenecer a uno o varios Teams mediante `project_teams`, pero el backend solo comprobaba que el Actor estuviera autenticado. Esa comprobación permitía que un Actor sin Membership mutara o archivara Projects, Milestones y Project Updates ajenos.

Project no tiene owner propio. `lead_id` es un dato de planificación y `project_updates.author_id` es auditoría, no una ACL. La Membership de los Teams del Project es la relación estable para autorizar.

## Decisión

- Un admin del Workspace puede gestionar cualquier Project y sus recursos dependientes.
- Un Actor no-admin puede gestionar un Project si pertenece al menos a uno de sus Teams. Los owners cuentan como members para este propósito.
- Milestones y Project Updates heredan la autorización del Project.
- Al crear un Project, un Actor no-admin debe pertenecer a todos los Teams destino. Si omite `teamIds`, el dominio conserva la compatibilidad de asociar todos los Teams actuales; por eso el Actor debe pertenecer a todos.
- Al reemplazar `teamIds`, un Actor no-admin debe pertenecer a todos los Teams destino. Así un member no puede agregar ni reasignar el Project a un Team ajeno.
- Los IDs inexistentes siguen llegando al dominio para conservar `NOT_FOUND`. La autorización no convierte errores de existencia en filtraciones.
- Las queries mantienen la visibilidad workspace-wide existente. Este ADR regula mutaciones y no cambia el alcance de lectura.

## Consecuencias

Los resolvers aplican la política antes de invocar el dominio y devuelven `UNAUTHORIZED` a los Actors autenticados sin permiso. Export/rebuild no cambia: son procesos internos y el modelo no agrega ownership.
