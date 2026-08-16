# ADR-0007: Memberships y alcance de iniciativas

- Estado: aceptado
- Fecha: 2026-08-16

## Contexto

Los actors necesitan pertenecer a teams para que los recursos team-scoped no queden
visibles para todo el workspace. Las iniciativas siguen siendo recursos del workspace,
pero algunas deben limitarse a uno o más teams.

## Decisión

- `Membership` se guarda como relación `Actor`–`Team`.
- Cada membership tiene el rol mínimo `member` u `owner`.
- El owner administra memberships y no se permite eliminar al último owner del team.
- Una iniciativa sin teams es workspace-scoped y es visible para cualquier actor autenticado.
- Una iniciativa con teams es visible y editable únicamente para members de al menos uno de esos
  teams; además, sus cambios siguen sujetos al owner de la iniciativa.
- Crear un team incorpora al actor autenticado como owner. Las instalaciones existentes se
  migran conservadoramente haciendo owners a sus actores existentes.

## Consecuencias

- La API expone CRUD de memberships y `Initiative.team(s)`/`teamIds`.
- Las consultas de iniciativas filtran recursos team-scoped según la membership del viewer y
  responden `NOT_FOUND` para evitar filtrar la existencia de recursos ajenos.
- El modelo no introduce todavía permisos por recurso ni roles adicionales.
