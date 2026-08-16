# El repo git es la fuente de verdad de los tickets; SQLite es un índice derivado

La fuente de verdad de un issue es un **log append-only de eventos** versionado en git
(`.prime-board/log/AT-155.jsonl`), acompañado de un snapshot markdown derivado
(`.prime-board/issues/AT-155.md`) que es lo que se lee en un PR. SQLite pasa a ser un
**índice descartable**, reconstruible con `bun run rebuild`.

El motivo es la colaboración entre agentes: es la única opción probada donde dos agentes
editando el mismo ticket en branches distintas **mergean solos y sin perder información**
(con `.prime-board/log/*.jsonl merge=union` en `.gitattributes`). De paso, los cambios de
tickets viajan en el mismo PR que el código y un agente puede leer los tickets sin que el
server esté corriendo.

## Considered Options

**Dolt** (base MySQL-compatible con semántica git) se descartó no por mala sino por
incompatible: su modo embebido es un driver de Go, así que desde Bun habría que levantar
`dolt sql-server` como demonio aparte y muere la premisa de un solo proceso.

**Snapshot markdown por issue, sin log** se descartó porque el merge de dos ediciones
concurrentes del mismo campo genera conflictos que alguien tiene que resolver a mano.

## Consequences

- Los eventos tienen que ser **autosuficientes**: la tabla `activity` original era un
  historial para la UI y no alcanzaba para reconstruir un issue (AT-165).
- Nada de UUIDs en lo que se escribe al repo: se regeneran en cada rebuild y rompen el
  determinismo. Hay un test que falla ante cualquier UUID en la salida.
- Los comentarios viven **solo** en el log, no duplicados en el snapshot.
- Un export parcial es peligroso: registra su alcance en `meta/export.json` y el importador
  se niega a reconstruir desde uno salvo `--allow-partial`. Ese flag reemplaza explícitamente
  el índice por el alcance parcial; no fusiona ni recupera los teams ausentes.
- Los secretos (hashes de API keys) **nunca** van al repo.
