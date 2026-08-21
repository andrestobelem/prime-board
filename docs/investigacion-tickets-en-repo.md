# Investigación: el repositorio como fuente de verdad de los tickets

> Ticket: PRB-153 · Investigación pedida por Andrés.
> **Decisión de partida (no evaluada, dada):** el repo debía ser la fuente de verdad.
> La pregunta era _cómo_ lograrlo sin perder queries rápidas, FTS ni escritura concurrente.
> **Estado:** investigación histórica del MVP. El contrato vigente usa SQLite como fuente
> operativa y `.prime-board/` como réplica; ver [ADR-0004](adr/0004-repo-como-fuente-de-verdad.md).

## TL;DR histórico

Esta investigación recomendó **event sourcing versionado en Git**. El repositorio guarda un **Log append-only de
eventos por Issue** (`.prime-board/log/PRB-155.jsonl`) como fuente de verdad. SQLite funciona como
**índice derivado y descartable**, que un comando puede reconstruir. Entre las opciones probadas, es la única
que permite que **dos agentes editen la misma Issue en branches distintas y hagan merge sin perder información**.

Dolt queda descartado para este objetivo, no por su calidad, sino porque no cumple dos premisas:
«el repositorio es la fuente de verdad» y «un proceso, cero configuración».

## 1. Opciones evaluadas

### 1.1 Dolt

Base compatible con MySQL y con semántica de Git (branch, diff y merge de datos).

|     |                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅  | Versionado real de datos, con diffs y merges a nivel de fila.                                                                                                                              |
| ✅  | **Sí soporta `FULLTEXT` + `MATCH ... AGAINST`** (desde 2023), así que la búsqueda no se pierde.                                                                                            |
| ❌  | El modo embebido es un **driver de Go**. Desde Bun/TypeScript hay que levantar `dolt sql-server` (demonio aparte) o shellear `dolt sql` — muere la premisa "un solo proceso, cero config". |
| ❌  | **Lo que queda versionado en el repo es una base opaca**, no archivos que se lean en un PR. El objetivo era justamente lo contrario.                                                       |
| ❌  | Reescribir la capa de datos: SQL dialecto MySQL, adiós `bun:sqlite` y FTS5.                                                                                                                |

**Veredicto:** es una herramienta excelente para versionar _datos SQL_, pero no sirve para «el repositorio es la
fuente de verdad y quiero leer las Issues en el diff». Si prime-board necesita branches de datos con SQL pesado,
se reevalúa la decisión.

### 1.2 Snapshot por issue (markdown + front-matter)

Un archivo por Issue con el estado actual. Es legible, pero falla en lo importante
(ver experimento): **dos agentes que comentan el mismo ticket producen un conflicto falso**,
cuando semánticamente los dos comentarios deberían coexistir.

### 1.3 Log append-only de eventos (event sourcing) ⭐

Un archivo por Issue al que el sistema solo agrega líneas: `created`, `state_changed`, `commented`…
El estado actual se **deriva** replicando el log. Es similar a lo que prime-board ya hace
en la tabla `activity` (append-only desde las primeras versiones): **el modelo de datos ya está listo para esto.**

### 1.4 Estilo `git-bug` (objetos y refs de git, fuera del working tree)

`git-bug` guarda cada issue como una cadena de operaciones inmutables en objetos git bajo
`refs/git-bug/…`, y al hacer merge de branches divergentes reconstruye el issue aplicando todas las
operaciones en orden determinista (relojes de Lamport, desempate por id).
Converge sin conflictos manuales — **valida el enfoque de log de operaciones** — pero los
issues **no se ven en el working tree ni en un PR**, que es lo que buscamos.

### 1.5 Híbrido (recomendado)

Log de eventos como fuente de verdad + snapshot markdown **derivado** para lectura humana.

## 2. Experimento

Hecho con los **35 issues reales** del board (incluye los 26 importados de Linear).

### Tamaño

| Representación                           | Tamaño      |
| ---------------------------------------- | ----------- |
| Snapshot markdown (35 archivos)          | 27.8 KB     |
| Log de eventos (35 archivos, 84 eventos) | **11.9 KB** |
| SQLite actual                            | 252 KB      |

El log es más chico que los snapshots: guarda transiciones, no texto repetido. Nada de esto
es problemático para git.

### Merge concurrente (la prueba que decide)

Escenario: dos agentes toman el mismo ticket desde la misma base.
`agent-a` lo pasa a _In Progress_ y comenta; `agent-b` le sube la prioridad y comenta.

```
# Sin configuración
CONFLICT (content): .prime-board/issues/AT-155.md      ← snapshot
CONFLICT (content): .prime-board/log/AT-155.jsonl      ← log

# Con .gitattributes:  .prime-board/log/*.jsonl merge=union
CONFLICT (content): .prime-board/issues/AT-155.md      ← snapshot (sigue fallando)
Auto-merging .prime-board/log/AT-155.jsonl             ← log: LIMPIO ✅
```

El log mergeado conserva **los dos eventos**. Reproduciéndolo:

```
{ state: "In Progress", priority: 1, labels: ["graphql"] }
```

Ambos cambios sobrevivieron, sin intervención humana. Y cuando dos agentes tocan **el mismo
campo**, el reducer resuelve determinísticamente por timestamp (last-write-wins), que es
exactamente lo que hace Linear cuando dos personas cambian el estado a la vez.

El snapshot Markdown, en cambio, obliga a resolver a mano un conflicto que **no existe
semánticamente**: ambos Comments deben conservarse.

## 3. Arquitectura recomendada

```
repo/
  .gitattributes                 # .prime-board/log/*.jsonl merge=union
  .prime-board/
    log/AT-155.jsonl             # ← FUENTE DE VERDAD (append-only)
    issues/AT-155.md             # ← derivado, legible en el PR (regenerado)
    meta/teams.json              # ← config: teams, estados, labels, proyectos
    meta/inbox-receipts.json     # ← read/archive del inbox (índice estable al log)
~/.prime-board/
  cache.db                       # ← índice SQLite DERIVADO (descartable)
  local.db                       # ← secretos (ver §4), NUNCA en el repo
```

- **Escritura:** cada mutación GraphQL agrega un evento al log y actualiza el índice.
- **Lectura:** todo sigue saliendo de SQLite → queries y **FTS5 intactos**, sin tocar la API.
- **Recuperación:** `pb rebuild` borra el índice y lo reconstruye leyendo el log. Si la DB se
  corrompe o se pierde, no pasa nada: es caché.
- **Colaboración:** `git pull` trae eventos de otros; `pb rebuild` (o un hook `post-merge`)
  reindexa. Sin servidor central.

Ventaja concreta para el caso de uso del proyecto: **un agente puede leer los tickets del repo
sin que el server esté corriendo**, y los cambios de tickets viajan en el mismo PR que el código.

## 4. Lo que NO puede ir al repo

El relevamiento identificó dos tablas con material sensible:

- `api_keys.hash` — hashes de las API keys de humanos y agentes.
- `webhooks.secret` — secretos de firma HMAC, **en texto plano**.

Versionarlos publicaría credenciales en el historial de Git y, si el repositorio fuera público, en GitHub. Deben quedar en una base local no versionada. "El repo es la fuente de verdad" aplica
a **datos de dominio**, no a credenciales.

## 5. Riesgos y decisiones abiertas

1. **Relojes.** Con un server local, ordenar por timestamp alcanza. Con varias máquinas, los
   relojes se desfasan: ahí conviene un reloj de Lamport como `git-bug`.
2. **Compactación.** Un issue con miles de eventos hace lento el replay. Mitigación: snapshot
   periódico + log incremental.
3. **¿Cuándo se commitea?** Automático por mutación (historial ruidoso, un commit por click),
   por sesión de agente, o explícito (`pb sync`). Propuesta: explícito por defecto, con opción
   de auto-commit.
4. **Snapshot derivado en el repo.** Si se commitea el `.md` generado, va a dar conflictos.
   Se resuelve con un merge driver que lo regenere desde el log, o no versionándolo.
5. **Identidad entre clones.** Dos clones que crean actores/labels en paralelo generan UUIDs
   distintos para "la misma" entidad. Para `meta/` conviene clave natural (key del team, nombre
   de label) en vez de UUID.
6. **Numeración.** `next_issue_number` no puede vivir en la DB: dos branches asignarían el
   mismo número. Debe derivarse del log (`max(number) + 1`) y aceptar que un merge puede
   requerir renumerar — ya tenemos `number` explícito en `issueCreate`.

## 6. Plan sugerido (incremental, sin big bang)

| Fase  | Qué                                                                                               | Riesgo |
| ----- | ------------------------------------------------------------------------------------------------- | ------ |
| **1** | Exportador `pb export`: el repo tiene una réplica legible. La DB sigue mandando.                  | Bajo   |
| **2** | Importador `pb rebuild`: la DB se reconstruye desde el repo. Ya se invierte la dependencia.       | Bajo   |
| **3** | Las mutaciones escriben primero al log; SQLite pasa a índice. `.gitattributes` con `merge=union`. | Medio  |
| **4** | Snapshot `.md` derivado + hooks de commit/merge. Secretos fuera del repo.                         | Medio  |

Después de la fase 2 el equipo puede borrar la DB sin perder datos. Esa fase entrega cerca del 80 % del valor.

## Fuentes

- Dolt: anuncio de índices FULLTEXT (dolthub.com, 2023) y documentación de CLI/driver embebido.
- `git-bug`: documento de diseño del modelo de datos y resolución de conflictos por relojes de
  Lamport (github.com/git-bug/git-bug).
- Experimento propio: 35 issues del board de prime-board, merges reales con git
  (`scratchpad/exp-repo-truth`, no versionado).

---

## Apéndice: lo que cambió al implementarlo

El equipo implementó la recomendación completa. Cuatro resultados difirieron de lo previsto:

1. **El log no era autosuficiente.** La tabla `activity` era un historial para la UI:
   `created` solo guardaba `{title}` y `description_changed` guardaba `{}`. Hubo que
   enriquecer los eventos antes de que el log pudiera ser fuente de verdad.
2. **Nada de UUIDs, ni siquiera escondidos.** El `commentId` del evento `commented` se
   filtraba al repo y, como se regenera en cada rebuild, **rompía el determinismo**: dos
   rebuilds producían archivos distintos. Hoy hay un test que falla ante cualquier UUID.
3. **Los comentarios no se duplican.** El plan original los ponía en el snapshot _y_ en el
   log. Viven solo en el log (que ya trae autor, fecha y body) y el importador los
   reconstruye desde ahí: una sola fuente, y encima la que mergea sin conflictos.
4. **Un export parcial es peligroso.** Reconstruir desde un export filtrado por team
   borraría en silencio el resto del workspace. El export registra su alcance en
   `meta/export.json` y el importador se niega salvo `--allow-partial`.

Ese era el estado propuesto al cerrar la investigación. El contrato implementado después
mantiene `bun run export`, `bun run rebuild` y la sincronización automática con
`PRIME_BOARD_REPO`, pero define la DB como fuente operativa y `.prime-board/` como réplica.
`bun run rebuild --from <repo> --allow-partial` hace un reemplazo explícito, nunca un merge. El detalle vigente
está en [ADR-0004](adr/0004-repo-como-fuente-de-verdad.md).
