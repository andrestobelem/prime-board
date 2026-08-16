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

## Política de funcionalidades sin equivalente

La migración no inventa campos en el modelo de prime-board. La política aprobada es:

| Dato de Linear                              | Tratamiento                                                                                                        | Resultado del plan        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Adjuntos                                    | Conservar URL, nombre y metadata como enlaces en una sección de la descripción; no copiar bytes automáticamente.   | `warning` por conversión. |
| Documents                                   | Conservar URL y título como enlaces en la descripción del issue/proyecto.                                          | `warning` por conversión. |
| Threads y comentarios inline                | Importar el cuerpo, autor y fecha como comentario plano; guardar el anclaje textual en el reporte.                 | `loss` si existe anclaje. |
| Ciclos, estimaciones y due dates            | No se agregan silenciosamente al esquema; se listan en el reporte y bloquean `apply` hasta una decisión explícita. | `loss`.                   |
| Status updates, initiatives y suscripciones | Se conservan como referencia en el reporte de migración; no se presentan como entidades de prime-board.            | `loss`.                   |
| Estado `duplicate`                          | Se crea el mismo nombre con tipo semántico `canceled`, dejando una advertencia.                                    | `warning`.                |

`--allow-losses` es obligatorio para aplicar una captura con `loss`; el corte oficial no debe
usarlo hasta que el reporte haya sido revisado y aceptado.

## CLI

La captura se convierte al formato del repo con:

```bash
bun run import:linear --from linear-export.json --out /tmp/prime-board-migration --dry-run --json

# Validar un staging ya generado
bun run import:linear --from linear-export.json --check /tmp/prime-board-migration --json
```

El comando no escribe durante `--dry-run`. Si el reporte no tiene conflictos ni pérdidas
no aprobadas, se puede producir el staging real quitando `--dry-run`. `--apply` es un
segundo consentimiento explícito: después de escribir el staging, reconstruye la base
SQLite indicada por la configuración local. No se debe usar sobre el repo operativo hasta
resolver el rekeying `PRB` y conservar un backup.

El conversor conserva los snapshots y logs en `.prime-board/` y escribe la trazabilidad en
`.prime-board/meta/source-map.json` y `.prime-board/meta/migration-report.json`. El mapa contiene
IDs externos de Linear; ninguno de los dos archivos debe contener API keys, hashes ni secretos
de webhooks.
