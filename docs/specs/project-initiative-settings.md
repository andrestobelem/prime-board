# Project e Initiative Settings

> Contrato vigente de planificación. Este documento es la referencia canónica para los campos,
> relaciones, autorización y exportación de Projects e Initiatives. La matriz de clientes indica
> qué camino está disponible; no convierte una operación ausente en una promesa de la aplicación.
>
> Verificado el 2026-09-06 contra los artefactos de planificación de PRB-391 y las correcciones
> PRB-608, PRB-609 y PRB-611 disponibles en la rama de trabajo. La integración de esta entrega en
> la rama principal sigue abierta.

## Alcance

La API separa los contratos y la autorización de `Project` e `Initiative`. Este ticket no duplica
las configuraciones que pertenecen a otros dominios.

### Project

Un `Project` expone estas propiedades y relaciones:

- Propiedades: `name`, `description`, `state`, `lead`, `startDate`, `targetDate`, `createdAt`,
  `updatedAt` y `archivedAt`. `state` usa `backlog`, `planned`, `started`, `paused`, `completed`
  o `canceled`.
- Alcance y personas: `teams` es una relación many-to-many; `members` contiene Actors asociados
  directamente al Project. `lead` es un dato de planificación, no una ACL.
- Trabajo: `milestones`, `issues` y `updates`. Un Issue debe pertenecer a un Team asociado al
  Project.
- Dependencies: `dependencies` apunta a otro Project mediante `dependsOnProject` y admite
  `blocks` o `related`. `projectDependencyCreate` permite elegir el tipo. `dependencyIds` en
  `ProjectCreateInput` y `ProjectUpdateInput` representa el conjunto de destinos y usa `blocks`.

`ProjectCreateInput` y `ProjectUpdateInput` aceptan `teamIds`, `memberIds` y `dependencyIds`.
Cada lista reemplaza el conjunto cuando se envía. Omitir `teamIds` al crear conserva la
compatibilidad y asocia todos los Teams actuales.

El modelo no agrega labels, resources, templates ni canales de notificación al Project. Esas
capacidades no se deben inferir de sus campos o de la paridad con Linear.

### Initiative

Una `Initiative` expone estas propiedades y relaciones:

- Propiedades: `name`, `description`, `state`, `priority` de 0 a 4, `targetDate`, `resources`
  como array JSON, `createdAt`, `updatedAt` y `archivedAt`. `state` usa `planned`, `active`,
  `completed` o `canceled`.
- Alcance y ownership: `owner` identifica al Actor que puede cambiarla; `leadTeam` es un dato de
  planificación. `teams` limita el alcance de la Initiative y `projects` contiene los Projects
  asociados.
- Organización: `labels` asocia Labels válidas del Workspace o de un Team.
- Seguimiento: `updates` contiene `InitiativeStatusUpdate` y `progress`, `completedIssues` y
  `totalIssues` se calculan a partir de los Issues de sus Projects. Las Issues con Workflow State
  `completed` o `canceled` cuentan como completadas; las archivadas se excluyen y el total es cero
  cuando no hay Issues.

Una Initiative no agrupa Issues directamente. Su visibilidad y sus cambios deben validar el
Workspace, los Teams y los Projects asociados. Una Initiative sin relaciones de Team o Project
sigue siendo workspace-scoped. `InitiativeCreateInput` y `InitiativeUpdateInput` aceptan `teamIds`,
`projectIds`, `labelIds`, `leadTeamId`, `resources` y `archived`; las listas reemplazan sus
relaciones cuando se envían. El modelo no agrega jerarquía de Initiatives, dependencias de
Initiatives ni documentos locales.

### Updates

- `ProjectStatusUpdate` tiene `health`, `body`, `risks`, `author`, `createdAt` y `updatedAt`.
  Es una nota narrativa y no cambia `Project.state`.
- `InitiativeStatusUpdate` tiene `health`, `body`, `author`, `createdAt` y `updatedAt`.
  GraphQL expone su creación y borrado. CLI y MCP todavía no tienen una operación dedicada para
  estos updates; no se debe documentar una herramienta que no existe.

## Ownership y límites de cada ticket

| Capacidad                                                          | Ticket dueño                                   | Límite                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| Campos, relaciones, ACL y export/rebuild de Projects e Initiatives | [PRB-391](http://localhost:3333/issue/PRB-391) | No crea templates, canales ni Views duplicados.                    |
| Templates de Issues y Projects                                     | [PRB-385](http://localhost:3333/issue/PRB-385) | PRB-391 consume la configuración cuando corresponda.               |
| Categorías y preferencias de notificación                          | [PRB-386](http://localhost:3333/issue/PRB-386) | Webhooks son integraciones y no un canal personal.                 |
| Views, display options y suscripciones                             | [PRB-390](http://localhost:3333/issue/PRB-390) | Initiative Views y transporte Slack conservan sus límites propios. |

## Autorización

La autorización se aplica en el server y no se reemplaza por validaciones de CLI o MCP. La
paridad de PostgreSQL tiene las brechas explícitas al final de esta sección:

- Un admin del Workspace puede administrar Projects dentro del Workspace. Un Project puede ser
  visible para un miembro directo o cuando el Actor tiene acceso a sus Teams asociados. Milestones,
  Project Updates e Issues relacionados heredan el alcance del Project.
- Una mutación de Project valida el acceso al Project y todos los Teams destino. Una dependency
  valida el Project origen, el Project destino, el tipo y la ausencia de self-dependency.
- Una Initiative sin owner puede ser mutada por un viewer autorizado. Si tiene owner, solo ese owner
  puede mutarla o borrarla, incluso si el viewer es admin. La lectura valida los Projects y Teams
  asociados, pero no usa el owner como requisito de lectura. Los recursos ajenos se ocultan con
  `NOT_FOUND` y las operaciones fuera de permiso devuelven `UNAUTHORIZED` según el caso.
- Una API key con límite de Teams debe cubrir todos los Teams implicados. El límite no agrega
  permisos. La creación PostgreSQL de una dependency todavía requiere completar la misma ACL que
  SQLite en [PRB-609](http://localhost:3333/issue/PRB-609). La revalidación de Team limits en
  PostgreSQL sigue en [PRB-618](http://localhost:3333/issue/PRB-618).

La implementación vigente aplica la ACL directa de `Project` cuando existe; sin esa relación,
valida cada Team asociado. Initiative valida cada Project y Team de su alcance. Esta regla no
resuelve por sí sola la diferencia entre el código de PRB-391 y los textos anteriores de `ADR-0007`
y `ADR-0012`; esos documentos requieren una decisión aparte. No uses sus frases históricas de
"al menos un Team" como una excepción a los checks actuales.

## Persistencia y clientes

SQLite es el backend predeterminado. `0031_planning_settings.sql` agrega `start_date`, las
relaciones de Project e Initiative y los checks de Workspace. En una DB singleton, los inserts
legacy sin `workspace_id` usan el autofill de las migraciones 0025 y 0031. Con varios Workspaces,
un insert sin selector falla. Un `workspace_id` explícito de otro Workspace también falla.

PostgreSQL es opcional y conserva un Workspace singleton durante la migración. `0012_planning_settings.sql`
agrega las mismas propiedades y relaciones sin modificar el baseline. PostgreSQL no tiene paridad
completa con SQLite y un campo del SDL no garantiza un path de persistencia en todos los backends.

| Capacidad                                                 | GraphQL | CLI `pb`                                                          | MCP                       | UI web  |
| --------------------------------------------------------- | ------- | ----------------------------------------------------------------- | ------------------------- | ------- |
| Project: `startDate`, `members`, `dependencies`           | Sí      | Sí, `pb project create/update --start-date/--member/--dependency` | Sí, `save_project`        | Parcial |
| Project Updates                                           | Sí      | Sí, `pb project update-create`                                    | Sí, `save_project_update` | Parcial |
| Initiative: `priority`, `leadTeam`, `labels`, `resources` | Sí      | Sí, `pb initiative create/update`                                 | Sí, `save_initiative`     | Parcial |
| Initiative Status Updates                                 | Sí      | No                                                                | No                        | No      |

La tabla no afirma que la UI exponga todos los campos. Tampoco afirma una operación CLI o MCP
para Initiative Status Updates. Los campos nuevos de clientes se integran con PRB-391; las
superficies que aún tienen tickets abiertos conservan su estado explícito.

## Export y rebuild

El export conserva solo datos soportados por el modelo:

- `meta/projects.json` conserva `name`, `description`, `state`, `lead`, `startDate`, `targetDate`,
  `members` por nombre, `dependencies` por nombre natural y tipo, `teams`, `milestones` y
  `archived`.
- `meta/project-updates.json` conserva el Project, el Actor autor, `health`, `body`, `risks` y
  la fecha.
- `meta/initiatives.json` conserva `name`, `description`, `state`, `priority`, `targetDate`,
  `leadTeam`, `resources`, `owner`, `labels`, `projects`, `teams`, `updates` y `archived`.

El export parcial por Team falla cerrado si una dependency, un Project de Initiative, un Team
asociado a Initiative, un `leadTeam` o una Label de Initiative queda fuera del alcance. Las labels
se validan por Workspace o Team. La relación `Project.teams` se proyecta al Team seleccionado en
un export parcial; no se debe presentar esa proyección como un error de exportación. El rebuild
valida la metadata, el Workspace, el alcance parcial y los nombres ambiguos antes de limpiar la DB.
Las referencias restantes se validan durante la transacción; cualquier error revierte la operación
y no deja estado parcial.
Los IDs internos de memberships, dependencies, relaciones y updates se regeneran.
Los secretos de API keys y Webhooks no se exportan. No se inventan campos para Templates,
notificaciones o Views. Saved Views siguen siendo una capacidad separada y se exportan en
`meta/saved-views.json`.

## Plan gates y diferencias con Linear

Linear limita las Initiatives asociadas a Teams y las Initiative Views según el plan. Prime-board
conserva las relaciones del modelo local-first y no simula billing. Templates pertenecen a
PRB-385, categorías y canales a PRB-386, y Views a PRB-390.

Las fechas usan `DateTime` en prime-board. Linear documenta `TimelessDate` para algunas fechas.
La diferencia queda explícita y no se normaliza de forma silenciosa.
