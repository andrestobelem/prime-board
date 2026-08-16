# Issue tracker: prime-board

Los issues de este repo viven en **prime-board**, el propio producto de este
repositorio (dogfooding). Team operativo **`PRB`** ("prime-board dev") del board local. Los `AT-*` son issues históricos importados de Linear.

- **API:** GraphQL en `$PRIME_BOARD_URL/graphql` (por defecto `http://localhost:3333`),
  autenticado con `Authorization: Bearer $PRIME_BOARD_API_KEY`.
- **CLI:** `pb` (alias de `bun apps/cli/src/index.ts`). Ver `docs/guia-agentes.md`.
- **MCP:** el server de `apps/mcp` expone las mismas tools que el MCP de Linear.
- **Réplica en el repo:** cada escritura se refleja en `.prime-board/` (ver
  `docs/investigacion-tickets-en-repo.md`). Es una réplica de lectura: **no editar
  esos archivos a mano**, escribir siempre por la API.
- **Linear:** queda como archivo de consulta; los `AT-*` importados conservan su trazabilidad en
  `.prime-board/meta/source-map.json` y no deben recibir nuevas escrituras operativas.

## Convenciones

- Un issue por unidad de trabajo, con identificador legible (`PRB-172`) inmutable.
- El estado de triage se registra como **estado del workflow**, no como label
  (ver `triage-labels.md`).
- Los hallazgos que aparecen al implementar se anotan como **issues nuevos**, no
  se dejan en la conversación.
- Los comentarios son el registro de evidencia: qué se entregó, cómo se verificó
  y qué quedó fuera de alcance.

## Cuando una skill dice "publish to the issue tracker"

```bash
pb issue create --team PRB --title "<título>" --description - [--label <label>] [--json]
```

Para varios tickets con dependencias (`/to-tickets`), crear uno por unidad y
declarar las dependencias como **relaciones nativas** (PRB-174):

```bash
pb issue link PRB-2 --blocked-by PRB-1     # PRB-2 no arranca hasta cerrar PRB-1
pb issue list --team PRB --unblocked      # el frontier: listos para trabajar
```

Tipos disponibles: `--blocked-by`, `--blocks`, `--related`, `--duplicate-of`.
Las relaciones de bloqueo rechazan ciclos.

## Cuando una skill dice "fetch the relevant ticket"

```bash
pb issue view PRB-172 --json     # incluye descripción, comentarios y actividad
pb issue list --team PRB --state "Ready for Agent" --json
```

## Cuando una skill dice "comment on the ticket"

```bash
pb issue comment PRB-172 --body -
```

## Cambiar el estado de triage

```bash
pb issue update PRB-172 --state "Ready for Agent"
```

## Wayfinding operations

Usado por `/wayfinder`. prime-board no tiene un concepto de "map" separado: el
**proyecto** hace de mapa y sus **milestones** ordenan las fases.

- **Map:** un proyecto (`pb project create --name "<effort>" --team PRB`); las notas
  y decisiones van en su descripción.
- **Child ticket:** un issue del proyecto, opcionalmente asignado a un milestone.
- **Blocking:** `pb issue link <ID> --blocked-by <ID>` (relación nativa, con validación de ciclos).
- **Frontier:** `pb issue list --team PRB --unblocked --json`, filtrando por proyecto.
- **Claim:** `pb issue update <ID> --state "In Progress" --assignee me`.
- **Resolve:** `pb issue comment <ID> --body -` con la respuesta y luego
  `pb issue update <ID> --state done`.
