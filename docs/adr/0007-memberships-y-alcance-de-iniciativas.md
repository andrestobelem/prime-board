# ADR-0007: Memberships y alcance de Initiatives

- Estado: aceptado
- Fecha: 2026-08-16

## Contexto

Los Actors deben pertenecer a Teams para que los recursos team-scoped no queden visibles para todo el Workspace. Las Initiatives siguen siendo recursos del Workspace, pero el producto debe poder limitar algunas a uno o más Teams.

## Decisión

- El sistema guarda `Membership` como relación `Actor`–`Team`.
- Cada Membership tiene, como mínimo, el rol `member` u `owner`.
- El owner administra Memberships. El sistema no permite eliminar al último owner del Team.
- Una Initiative sin Teams es workspace-scoped y cualquier Actor autenticado puede verla.
- Una Initiative asociada a Teams solo es visible y editable para los members de al menos uno de esos Teams. Sus cambios también deben cumplir las reglas del owner de la Initiative.
- Crear un Team incorpora al Actor autenticado como owner. En instalaciones existentes, la migración asigna de forma conservadora el rol owner a sus Actors existentes.

## Consecuencias

- La API expone CRUD de Memberships y `Initiative.team(s)`/`teamIds`.
- Las queries de Initiatives filtran recursos team-scoped según la Membership del viewer y responden `NOT_FOUND` para no revelar la existencia de recursos ajenos.
- El modelo todavía no introduce permisos por recurso ni roles adicionales.
