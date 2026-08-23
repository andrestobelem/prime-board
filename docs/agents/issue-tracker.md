# Issue tracker: prime-board

Los issues de este repositorio viven en **prime-board**, el propio producto del repositorio (dogfooding). El Team operativo es **`PRB`** ("prime-board dev") del board local. Los `AT-*` son Issues históricas importadas de Linear.

- **API:** GraphQL en `$PRIME_BOARD_URL/graphql` (por defecto, `http://localhost:3333`). Se autentica con `Authorization: Bearer $PRIME_BOARD_API_KEY`.
- **CLI:** `pb` (alias de `bun apps/cli/src/index.ts`). Consulta `docs/guia-agentes.md`.
- **MCP:** el server de `apps/mcp` ofrece tools para operar el Workspace, Teams, Issues,
  Projects y otras entidades. Consulta la [guía de operación](../guia-agentes.md#6-mcp) para
  los nombres y ejemplos disponibles.
- **Réplica en el repositorio:** cada escritura se refleja en `.prime-board/`. La investigación
  [Tickets en el repositorio](../investigacion-tickets-en-repo.md) es histórica; el contrato vigente
  usa SQLite como fuente operativa y `.prime-board/` como réplica. **No edites esos archivos a mano**;
  escribe siempre mediante la API.
- **Linear:** funciona como archivo de consulta. Los `AT-*` importados conservan su trazabilidad en `.prime-board/meta/source-map.json` y no reciben nuevas escrituras operativas.

## Convenciones

- Usa un Issue por unidad de trabajo y un Identifier legible e inmutable (`PRB-172`).
- Registra el estado de triage como **estado del workflow**, no como label (consulta `triage-labels.md`).
- Registra como **Issues nuevas** los hallazgos que aparezcan durante la implementación. No los dejes solo en la conversación.
- Usa los comentarios como registro de evidencia: indica qué entregaste, cómo lo verificaste y qué quedó fuera de alcance.
- Entrega una unidad con SHA, criterios cubiertos, verificación, brechas y siguiente estado. Usa `Ready for Review` cuando una entrega necesita revisión independiente.
- Envía un aviso directo a `admin` al terminar o quedar bloqueado. El comentario del Issue conserva la evidencia; el aviso activa la coordinación.

## Cuando una skill diga «publish to the issue tracker»

```bash
pb issue create --team PRB --title "<título>" --description - [--label <label>] [--json]
```

Para varios tickets con dependencias (`/to-tickets`), crea un Issue por unidad y declara las dependencias como **relaciones nativas** (PRB-174):

```bash
pb issue link PRB-2 --blocked-by PRB-1     # PRB-2 no arranca hasta cerrar PRB-1
pb issue list --team PRB --unblocked       # frontier: Issues listas para trabajar
```

Tipos disponibles: `--blocked-by`, `--blocks`, `--related`, `--duplicate-of`. Las relaciones de bloqueo rechazan ciclos.

## Cuando una skill diga «fetch the relevant ticket»

```bash
pb issue view PRB-172 --json     # incluye descripción, comentarios y Activity
pb issue list --team PRB --state "Ready for Agent" --json
```

## Cuando una skill diga «comment on the ticket»

```bash
pb issue comment PRB-172 --body -
```

## Cambiar el estado de triage

```bash
pb issue update PRB-172 --state "Ready for Agent"
```

## Operaciones de wayfinding

Las usa `/wayfinder`. prime-board no tiene un concepto separado de «map»: el **Project** funciona como mapa y sus **Milestones** ordenan las fases.

- **Map:** crea un Project (`pb project create --name "<effort>" --team PRB`). Escribe las notas y decisiones en su descripción.
- **Child ticket:** crea un Issue del Project y asígnalo de forma opcional a un Milestone.
- **Blocking:** usa `pb issue link <ID> --blocked-by <ID>` (relación nativa con validación de ciclos).
- **Frontier:** ejecuta `pb issue list --team PRB --unblocked --json` y filtra por Project.
- **Claim:** ejecuta `pb issue update <ID> --state "In Progress" --assignee me`.
- **Handoff:** comenta SHA, criterios, comandos, resultados, brechas y siguiente estado; luego cambia a `Ready for Review`.
- **Review:** verifica la entrega de forma independiente. Usa `Done` si pasa o `In Progress` si requiere cambios.
