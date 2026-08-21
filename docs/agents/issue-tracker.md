# Issue tracker: prime-board

Los issues de este repositorio viven en **prime-board**, el propio producto del repositorio (dogfooding). El Team operativo es **`PRB`** ("prime-board dev") del board local. Los `AT-*` son Issues históricas importadas de Linear.

- **API:** GraphQL en `$PRIME_BOARD_URL/graphql` (por defecto, `http://localhost:3333`). Se autentica con `Authorization: Bearer $PRIME_BOARD_API_KEY`.
- **CLI:** `pb` (alias de `bun apps/cli/src/index.ts`). Consulta `docs/guia-agentes.md`.
- **MCP:** el server de `apps/mcp` expone las mismas tools que el MCP de Linear.
- **Réplica en el repositorio:** cada escritura se refleja en `.prime-board/` (consulta `docs/investigacion-tickets-en-repo.md`). Es una réplica de lectura. **No edites esos archivos a mano**; escribe siempre mediante la API.
- **Linear:** funciona como archivo de consulta. Los `AT-*` importados conservan su trazabilidad en `.prime-board/meta/source-map.json` y no reciben nuevas escrituras operativas.

## Convenciones

- Usa un Issue por unidad de trabajo y un Identifier legible e inmutable (`PRB-172`).
- Registra el estado de triage como **estado del workflow**, no como label (consulta `triage-labels.md`).
- Registra como **Issues nuevas** los hallazgos que aparezcan durante la implementación. No los dejes solo en la conversación.
- Usa los comentarios como registro de evidencia: indica qué entregaste, cómo lo verificaste y qué quedó fuera de alcance.

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
- **Resolve:** comenta la respuesta con `pb issue comment <ID> --body -` y luego cambia el estado a `done` con `pb issue update <ID> --state done`.
