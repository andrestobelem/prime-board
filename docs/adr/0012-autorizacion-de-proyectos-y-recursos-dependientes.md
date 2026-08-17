# ADR-0012: autorización de proyectos y recursos dependientes

- **Estado:** aceptado
- **Fecha:** 2026-08-17
- **Contexto:** PRB-272

## Contexto

Los proyectos pueden pertenecer a uno o varios teams mediante `project_teams`, pero el
backend solo comprobaba que el actor estuviera autenticado. Eso permitía que un actor sin
membership mutara o archivara proyectos, milestones y project updates ajenos.

Project no tiene un owner propio; `lead_id` es un dato de planificación y
`project_updates.author_id` es auditoría, no una ACL. La relación estable para autorizar es
la membership de los teams del proyecto.

## Decisión

- Un admin del Workspace puede gestionar cualquier proyecto y sus recursos dependientes.
- Un actor no-admin puede gestionar un proyecto si pertenece a por lo menos uno de sus teams.
  Los owners cuentan como members para este propósito.
- Milestones y project updates heredan la autorización del proyecto.
- Al crear un proyecto, un actor no-admin debe pertenecer a todos los teams destino. Si se
  omite `teamIds`, el dominio conserva la compatibilidad de asociar todos los teams actuales,
  por lo que el actor debe pertenecer a todos ellos.
- Al reemplazar `teamIds` de un proyecto, un actor no-admin debe pertenecer a todos los teams
  destino. Esto evita que un miembro agregue o reasigne el proyecto a un team ajeno.
- Los IDs inexistentes siguen llegando al dominio para conservar `NOT_FOUND`; la autorización
  no convierte errores de existencia en filtraciones.
- Las queries mantienen la visibilidad workspace-wide existente. Este ADR regula mutaciones,
  no introduce un cambio de alcance de lectura.

## Consecuencias

Los resolvers aplican la política antes de invocar el dominio y devuelven `UNAUTHORIZED` para
actores autenticados sin permiso. Export/rebuild no cambia: son procesos internos y el modelo no
agrega ownership.
