# ADR-0009: autorización de la configuración de teams

- Estado: aceptado
- Fecha: 2026-08-16

Las mutations de configuración de un **Team** (`teamUpdate`, workflow states, labels y cycles) requieren `admin` del Workspace o `owner` del Team. Los `member` y los actors sin membership no pueden modificar esa configuración; los labels del Workspace (sin `teamId`) quedan reservados a `admin`. La autorización se comprueba antes de mutar y mantiene `NOT_FOUND` para recursos inexistentes, mientras que un actor autenticado sin permisos recibe `UNAUTHORIZED`. Esta matriz aplica el principio de mínimo privilegio sin introducir permisos intermedios no modelados.

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

La API es la autoridad final y devuelve `UNAUTHORIZED` para un Actor autenticado sin capacidad.
La UI solo ofrece controles de Settings cuando la misma capacidad es verdadera; CLI y MCP no
suponen permisos por la superficie desde la que llega la operación.

En particular, `teamCreate` es una operación de Workspace y requiere `Workspace Admin`; crear un
Team no se concede por ser miembro u owner de otro Team. Esta regla evita que una mutación expuesta
por CLI/MCP tenga una capacidad que la UI no muestra.
