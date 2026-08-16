# Contrato de migración Linear → prime-board

> Tickets: AT-187 y AT-192.

## Propósito

La migración recibe un **Linear export** en JSON y produce un plan determinista para
crear o actualizar entidades de prime-board. El export es una captura de lectura; el
importador nunca necesita credenciales de Linear ni escribe en Linear.

El proceso tiene dos fases: `plan` valida y calcula operaciones sin mutar la base;
`apply` ejecuta exactamente un plan previamente validado.

## Identidad y trazabilidad

Cada entidad de origen lleva `source: "linear"` e `id`, el UUID de Linear. El mapa
persistido usa esa clave, nunca nombres ni títulos:

```json
{
  "version": 1,
  "source": "linear",
  "workspaceId": "…",
  "entities": {
    "issues": { "uuid-linear": "AT-42" },
    "actors": { "uuid-linear": "Andrés Tobelem" },
    "projects": { "uuid-linear": "BizaClaw" }
  }
}
```

El identificador legible de un issue se conserva cuando el namespace está libre. Si
existe una colisión, el plan la marca como `conflict` y no elige silenciosamente.

## Entidades mínimas

El export debe incluir: workspace, teams, actores, workflow states, labels, proyectos,
milestones, issues, comentarios, relaciones y, cuando estén disponibles, historial de
estados. Los IDs de referencia se resuelven antes de escribir; una referencia desconocida
es un error del plan.

### Issue

Un issue contiene al menos `id`, `identifier`, `teamId`, `number`, `title`, `description`,
`stateId`, `priority`, `assigneeId`, `creatorId`, `parentId`, `projectId`, `milestoneId`,
`labelIds`, `createdAt`, `updatedAt` y `archivedAt`. Los campos ausentes se distinguen de
los valores explícitamente nulos.

### Comentario y actividad

Los comentarios conservan `id`, `issueId`, `authorId`, `body`, `createdAt` y, si Linear
lo entrega, `parentId` y `quotedText`. La actividad conserva su tipo, actor, timestamp y
payload original. Los comentarios inline o threads sin equivalente directo se registran
en el reporte de pérdida antes de aplicar.

## Resolución de nombres

- Actors: `source id`; el nombre solo se muestra y nunca es clave.
- Teams: `source id`, con `key` como identificador legible validado.
- States: `team source id + state source id`; `type` se mapea a la semántica de
  prime-board. Un tipo que prime-board no conozca genera conflicto.
- Labels: `team source id + label source id`.
- Projects y milestones: `source id`; el nombre no desambigua.
- Issues: `source id` y `identifier`; padres, relaciones y comentarios se resuelven en una
  segunda pasada, cuando todos los issues ya tienen destino.

## Reporte

Cada elemento del plan termina en uno de estos estados:

- `create`: no existe destino y se puede crear.
- `update`: existe correspondencia de origen y el cambio es compatible.
- `unchanged`: el destino ya representa exactamente el origen.
- `conflict`: hay colisión de namespace, referencia ambigua o incompatibilidad.
- `loss`: hay un dato sin representación y no existe una política aprobada.

El proceso solo aplica cuando no quedan `conflict` ni `loss`. El reporte debe ser legible
y también serializable como JSON para agentes.

## Idempotencia

Dos ejecuciones sobre el mismo export y el mismo estado producen el mismo plan y cero
operaciones nuevas en la segunda ejecución. El mapa de origen se versiona con el repo,
pero nunca contiene hashes de API keys ni secretos de webhooks.

## Fuera de representación

Antes del primer apply, AT-189 debe decidir la política de adjuntos, documentos, threads,
ciclos, due dates, estimaciones, status updates, iniciativas, suscripciones y metadatos
de proyectos. Una conversión a markdown o enlace es una pérdida explícita, no un éxito
silencioso.
