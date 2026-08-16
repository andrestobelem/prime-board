# Registro git de la réplica operativa de los tickets

> **Estado:** contrato vigente desde la activación de `.prime-board/`.
> Este documento conserva el razonamiento histórico del MVP, pero las reglas de esta
> sección son las que deben seguir el código y los agentes.

## Decisión vigente

La base SQLite es la **fuente operativa** de prime-board. Todas las escrituras pasan por
la API y el server puede sincronizar una réplica legible en `.prime-board/` cuando está
configurado `PRIME_BOARD_REPO`. La réplica contiene snapshots, eventos y metadatos para
revisión, versionado y recuperación; no se edita a mano ni reemplaza automáticamente a
la DB.

- `bun run export` exporta el workspace completo por defecto. `--team KEY` produce un
  export parcial y escribe su alcance en `.prime-board/meta/export.json`.
- `bun run rebuild --from <repo>` reemplaza el índice SQLite leyendo la réplica indicada.
  Debe ejecutarse de forma explícita, después de revisar el export, y no es un merge.
- Un export parcial se rechaza por defecto para evitar borrar los teams ausentes. Solo
  `bun run rebuild --from <repo> --allow-partial` lo acepta; el flag confirma que el
  índice completo debe reemplazarse por ese alcance parcial.
- Las API keys y los secretos de webhooks no se exportan. El rebuild conserva las keys
  locales que puede volver a asociar al mismo actor; si no hay una correspondencia, no
  inventa credenciales.
- El formato del repo no depende de UUIDs internos. Los identificadores naturales y los
  eventos permiten regenerar el índice sin cambiar el contenido versionado.

Todo cambio persistente de un issue forma parte del historial append-only: las
asignaciones de `cycle_id` se registran como `cycle_changed` y las de `sort_order` como
`sort_order_changed`, ambos con `from` y `to`. Los cycles se exportan por la clave estable
`TEAM/number` para que esos eventos sobrevivan a un rebuild. Al eliminar un cycle, los
payloads históricos que aún lo referencian se canonizan a esa clave antes de borrar la
fila.

## Contexto histórico del MVP

La propuesta original evaluó tratar el log git como fuente de verdad y a SQLite como un
índice descartable. La opción buscaba que dos branches pudieran combinar eventos sin
conflictos y descartó Dolt por exigir un proceso adicional. Esa investigación se conserva
en [`docs/investigacion-tickets-en-repo.md`](../investigacion-tickets-en-repo.md), pero no
describe el flujo operativo actual: hoy la DB manda y el repo es su réplica controlada.

El diseño histórico dejó decisiones que sí siguen vigentes:

- Los eventos son autosuficientes: `created` conserva el estado inicial y cada cambio
  guarda los valores necesarios para reconstruirlo.
- Los comentarios viven en el log, no duplicados en el snapshot.
- `.gitattributes` puede usar `merge=union` para logs, pero un merge de ramas no se
  aplica a la DB sin una revisión y un export completo.
