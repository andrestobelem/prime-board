# Registro Git de la réplica operativa de los tickets

> **Estado:** contrato vigente desde la activación de `.prime-board/`.
> Este documento conserva el razonamiento histórico del MVP. Las reglas de esta sección son las que deben seguir el código y los agentes.

## Decisión vigente

La base SQLite es la **fuente operativa** de prime-board. Todas las escrituras pasan por la API. Cuando `PRIME_BOARD_REPO` está configurado, el server sincroniza una réplica legible en `.prime-board/`. La réplica contiene snapshots, eventos y metadata para revisión, versionado y recuperación. El equipo no la edita a mano y la DB no la reemplaza automáticamente.

- `bun run export` exporta el Workspace completo por defecto. `--team KEY` produce un export parcial y escribe su alcance en `.prime-board/meta/export.json`.
- `bun run rebuild --from <repo>` reemplaza el índice SQLite leyendo la réplica indicada. El operador debe ejecutarlo explícitamente después de revisar el export. El comando no hace merge.
- El sistema rechaza por defecto un export parcial para evitar el borrado de los Teams ausentes. Solo `bun run rebuild --from <repo> --allow-partial` acepta ese export. El flag confirma que el índice completo debe reemplazarse por el alcance parcial.
- El export excluye API keys y secretos de webhooks. El rebuild conserva las keys locales que puede asociar al mismo Actor. Si no encuentra una correspondencia, no inventa credenciales.
- El formato de las entidades usa Identifiers naturales y eventos para regenerar el índice. `meta/actors.json` conserva el id local del Actor solo para volver a asociar API keys después de un rebuild. Nunca contiene hashes ni secretos.

Todo cambio persistente de una Issue forma parte del historial append-only. Las asignaciones de `cycle_id` se registran como `cycle_changed` y las de `sort_order` como `sort_order_changed`; ambos eventos incluyen `from` y `to`. El export identifica Cycles mediante la clave estable `TEAM/number`, para que esos eventos sobrevivan a un rebuild. Al eliminar un Cycle, el sistema canoniza a esa clave los payloads históricos que aún lo referencian antes de borrar la fila.

## Contexto histórico del MVP

La propuesta original evaluó el Log Git como fuente de verdad y SQLite como índice descartable. Buscaba combinar eventos de dos branches sin conflictos y descartó Dolt porque exigía un proceso adicional. La investigación se conserva en [`docs/investigacion-tickets-en-repo.md`](../investigacion-tickets-en-repo.md), pero no describe el flujo actual: hoy la DB manda y el repositorio es su réplica controlada.

El diseño histórico dejó estas decisiones vigentes:

- Los eventos son autosuficientes: `created` conserva el estado inicial y cada cambio guarda los valores necesarios para reconstruirlo.
- Los comentarios viven en el Log y no se duplican en el snapshot.
- `.gitattributes` puede usar `merge=union` para Logs, pero un merge de branches no se aplica a la DB sin revisión y export completo.
