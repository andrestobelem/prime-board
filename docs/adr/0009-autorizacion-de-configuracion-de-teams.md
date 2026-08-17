# ADR-0009: autorización de la configuración de teams

- Estado: aceptado
- Fecha: 2026-08-16

Las mutations de configuración de un **Team** (`teamUpdate`, workflow states, labels y cycles) requieren `admin` del Workspace o `owner` del Team. Los `member` y los actors sin membership no pueden modificar esa configuración; los labels del Workspace (sin `teamId`) quedan reservados a `admin`. La autorización se comprueba antes de mutar y mantiene `NOT_FOUND` para recursos inexistentes, mientras que un actor autenticado sin permisos recibe `UNAUTHORIZED`. Esta matriz aplica el principio de mínimo privilegio sin introducir permisos intermedios no modelados.
