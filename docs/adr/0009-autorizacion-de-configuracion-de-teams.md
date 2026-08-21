# ADR-0009: Autorización de la configuración de Teams

- Estado: aceptado
- Fecha: 2026-08-16

Las mutations de configuración de un **Team** (`teamUpdate`, Workflow States, Labels y Cycles) requieren `admin` del Workspace o `owner` del Team. Los `member` y los Actors sin Membership no pueden modificar esa configuración. Los Labels del Workspace (sin `teamId`) quedan reservados a `admin`. El sistema comprueba la autorización antes de mutar. Mantiene `NOT_FOUND` para recursos inexistentes y devuelve `UNAUTHORIZED` a un Actor autenticado sin permisos. Esta matriz aplica el principio de mínimo privilegio sin introducir permisos intermedios no modelados.

## Matriz revisada para Settings

La misma frontera se aplica en todas las superficies API-first (GraphQL, CLI, MCP y UI):

| Operación                                                | Workspace Admin | Team Owner     | Team Member / outsider |
| -------------------------------------------------------- | --------------- | -------------- | ---------------------- |
| Renombrar Workspace                                      | Sí              | No             | No                     |
| Crear, archivar, restaurar o borrar Team                 | Sí              | No             | No                     |
| Editar configuración, workflow, labels y cycles del Team | Sí              | Sí, en su Team | No                     |
| Administrar memberships del Team                         | Sí              | Sí, en su Team | No                     |
| Crear Actors o administrar Actors/keys ajenos            | Sí              | No             | No                     |
| Editar su propio Actor y sus propias keys                | Sí              | Sí             | Sí                     |

La API es la autoridad final y devuelve `UNAUTHORIZED` a un Actor autenticado sin capacidad. La UI solo ofrece controles de Settings cuando la capacidad es verdadera. CLI y MCP no suponen permisos según la superficie que recibe la operación.

`teamCreate` es una operación de Workspace y requiere `Workspace Admin`. Ser miembro u owner de otro Team no concede esta capacidad. La regla evita que una mutation expuesta por CLI/MCP tenga una capacidad que la UI no muestra.
