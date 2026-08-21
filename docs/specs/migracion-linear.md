# Contrato de migración Linear → prime-board

## Propósito

La migración recibe un **Linear export** en JSON y produce un plan determinista para crear o actualizar entidades de prime-board. El export es una captura de lectura. El importador no necesita credenciales de Linear ni escribe en Linear.

El proceso tiene dos fases: `plan` valida y calcula operaciones sin mutar la base; `apply` ejecuta exactamente un plan validado antes.

## Identidad y trazabilidad

Cada entidad de origen incluye `source: "linear"` e `id`, el UUID de Linear. El mapa persistido usa esa clave, nunca nombres ni títulos:

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

El sistema conserva el Identifier legible de una Issue cuando el namespace está libre. Si detecta una colisión, el plan la marca como `conflict` y no elige en silencio.

## Entidades mínimas

El export debe incluir Workspace, Teams, Actors, Workflow States, Labels, Projects, Milestones, Issues, Comments, Relations y, cuando esté disponible, el historial de estados. El importador resuelve los IDs de referencia antes de escribir. Una referencia desconocida produce un error del plan.

### Issue

Una Issue contiene al menos `id`, `identifier`, `teamId`, `number`, `title`, `description`, `stateId`, `priority`, `assigneeId`, `creatorId`, `parentId`, `projectId`, `milestoneId`, `labelIds`, `createdAt`, `updatedAt` y `archivedAt`. El plan distingue los campos ausentes de los valores explícitamente nulos.

### Comment y Activity

Un Comment conserva `id`, `issueId`, `authorId`, `body`, `createdAt` y, si Linear lo entrega, `parentId` y `quotedText`. Activity conserva tipo, Actor, timestamp y payload original. El importador registra los Comments inline o Threads sin equivalente directo en el reporte de pérdida antes de aplicar.

## Resolución de nombres

- Actors: `source id`; el nombre solo se muestra y nunca es una clave.
- Teams: `source id`, con `key` como Identifier legible validado.
- Workflow States: `team source id + state source id`; `type` se mapea a la semántica de prime-board. Un tipo desconocido produce conflicto.
- Labels: `team source id + label source id`.
- Projects y Milestones: `source id`; el nombre no desambigua.
- Issues: `source id` e `identifier`; el importador resuelve Parents, Relations y Comments en una segunda pasada, cuando todas las Issues ya tienen destino.

## Reporte

Cada elemento del plan termina en uno de estos estados:

- `create`: no existe destino y se puede crear.
- `update`: existe correspondencia de origen y el cambio es compatible.
- `unchanged`: el destino ya representa exactamente el origen.
- `conflict`: existe una colisión de namespace, una referencia ambigua o una incompatibilidad.
- `loss`: falta una representación para un dato y no existe una política aprobada.

El proceso solo aplica si no quedan `conflict` ni `loss`. La CLI también rechaza capturas cuyos IDs de origen no sean UUIDs. Conserva los Identifiers legibles (`AT-42`) en un campo separado. El reporte debe ser legible y serializable como JSON para agentes.

## Idempotencia

Dos ejecuciones sobre el mismo export y el mismo estado producen el mismo plan. La segunda ejecución no produce operaciones nuevas. El repositorio versiona el mapa de origen, pero este nunca contiene hashes de API keys ni secretos de webhooks.

## Fuera de representación

Antes del primer apply, el equipo debe decidir la política para adjuntos, Documents, Threads, Cycles, due dates, estimaciones, Project Updates, Initiatives, suscripciones y metadata de Projects. Convertir un dato a Markdown o a un enlace es una pérdida explícita, no un éxito silencioso.

## Política de funcionalidades sin equivalente

La migración no inventa campos en el modelo de prime-board. Esta es la política aprobada:

| Dato de Linear                               | Tratamiento                                                                                                    | Resultado del plan        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Adjuntos                                     | Conserva URL, nombre y metadata como enlaces en una sección de la descripción; no copia bytes automáticamente. | `warning` por conversión. |
| Documents                                    | Conserva URL y título como enlaces en la descripción de la Issue o del Project.                                | `warning` por conversión. |
| Threads y Comments inline                    | Importa cuerpo, autor y fecha como Comment plano; guarda el anclaje textual en el reporte.                     | `loss` si existe anclaje. |
| Cycles, estimaciones y due dates             | No los agrega en silencio al esquema; los lista en el reporte y bloquea `apply` hasta una decisión explícita.  | `loss`.                   |
| Project Updates, Initiatives y suscripciones | Los conserva como referencia en el reporte de migración; no los presenta como entidades de prime-board.        | `loss`.                   |
| Estado `duplicate`                           | Crea el mismo nombre con State Type `canceled` y deja un warning.                                              | `warning`.                |

`--allow-losses` es obligatorio para aplicar una captura con `loss`. El corte oficial no debe usarlo hasta revisar y aceptar el reporte.

## CLI

La captura se convierte al formato del repositorio con:

```bash
bun run import:linear --from linear-export.json --out /tmp/prime-board-migration --dry-run --json

# Validar un staging ya generado
bun run import:linear --from linear-export.json --check /tmp/prime-board-migration --json

# Combinar Linear con el repositorio local y cambiar colisiones a PRB
bun run import:linear --from linear-export.json --merge-local /ruta/prime-board --out /tmp/prime-board-merged --json
```

El comando no escribe durante `--dry-run`. Si el reporte no tiene conflictos ni pérdidas no aprobadas, produce el staging real al quitar `--dry-run`. `--apply` es un segundo consentimiento explícito. Después de escribir el staging, reconstruye la base SQLite indicada por la configuración local. No lo uses sobre el repositorio operativo hasta resolver el cambio de clave `PRB` y conservar un backup.

`--merge-local` conserva las Issues locales no equivalentes y las cambia a `PRB`. Siempre escribe en un output nuevo.

El conversor conserva snapshots y Logs en `.prime-board/` y escribe la trazabilidad en `.prime-board/meta/source-map.json` y `.prime-board/meta/migration-report.json`. El mapa contiene IDs externos de Linear. Ninguno de los dos archivos debe contener API keys, hashes ni secretos de webhooks.
