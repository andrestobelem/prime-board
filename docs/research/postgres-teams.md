# Teams y workflow states en PostgreSQL

- **Ticket:** PRB-432
- **Implementación:** `apps/server/src/domain/postgres-teams.ts`

## Alcance

El modo PostgreSQL permite consultar Teams, crear/actualizar/archivar/restaurar
y borrar Teams vacíos, además de crear/actualizar/borrar workflow states.
Cada Team nuevo recibe el workflow default completo y una membership `owner`
para el actor que lo crea, usada por la autorización de la configuración del
workflow. La API de memberships (listado, alta y baja) también se resuelve en
PostgreSQL con la regla de conservar al menos un owner.

`visibility` y `access_policy` se validan con las mismas reglas que SQLite: un
Team privado exige `team_members`. La lectura de Teams aplica el alcance en
PostgreSQL: admins descubren todos, Teams públicos son descubribles y los
privados solo aparecen para memberships activas. Las operaciones de labels,
projects y cycles todavía no migradas también fallan explícitamente, sin caer
en el SQLite efímero.

## Invariantes

- IDs, key, visibilidad y referencias se conservan al archivar/restaurar; un
  Team archivado sigue consultable solo con `includeArchived` y bloquea cambios
  operativos.
- Keys tienen el mismo formato y unicidad case-insensitive por normalización a
  mayúsculas. Nombres de estados son únicos dentro de su Team.
- Un Team conserva al menos un estado y al menos un estado `completed`.
- El estado default siempre pertenece al Team. Borrar el default lo reasigna a
  la migración indicada o al estado restante de menor posición.
- Borrar un estado con issues exige `moveToStateId`, actualiza las issues en una
  transacción, registra actividad `state_changed` y conserva referencias
  históricas como `TEAM/State`.
- Borrar un Team comprueba blockers (issues, proyectos, cycles, labels, saved
  views, initiatives y allowlists) antes de eliminar memberships/estados.

## Validación

La smoke GraphQL compartida se ejecuta contra PostgreSQL efímero:

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-actors.ts
```

Verifica creación con workflow, visibilidad privada para otro actor,
alta/listado/autorización de memberships, rechazo explícito de un nested resolver no migrado, actualización de Team/default,
creación y actualización de estado, borrado de estado, archivado/restauración
y delete con confirmación. El reporte incluye `teams: true` junto con auth,
credentials e invitaciones.
