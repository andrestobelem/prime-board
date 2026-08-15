# Issue tracker: prime-board

Los issues de este repo viven en **prime-board**, el propio producto de este
repositorio (dogfooding). Team **`AT`** ("prime-board dev") del board local.

- **API:** GraphQL en `$PRIME_BOARD_URL/graphql` (por defecto `http://localhost:3333`),
  autenticado con `Authorization: Bearer $PRIME_BOARD_API_KEY`.
- **CLI:** `pb` (alias de `bun apps/cli/src/index.ts`). Ver `docs/guia-agentes.md`.
- **MCP:** el server de `apps/mcp` expone las mismas tools que el MCP de Linear.
- **Réplica en el repo:** cada escritura se refleja en `.prime-board/` (ver
  `docs/investigacion-tickets-en-repo.md`). Es una réplica de lectura: **no editar
  esos archivos a mano**, escribir siempre por la API.

## Convenciones

- Un issue por unidad de trabajo, con identificador legible (`AT-172`) inmutable.
- El estado de triage se registra como **estado del workflow**, no como label
  (ver `triage-labels.md`).
- Los hallazgos que aparecen al implementar se anotan como **issues nuevos**, no
  se dejan en la conversación.
- Los comentarios son el registro de evidencia: qué se entregó, cómo se verificó
  y qué quedó fuera de alcance.

## Cuando una skill dice "publish to the issue tracker"

```bash
pb issue create --team AT --title "<título>" --description - [--label <label>] [--json]
```

Para varios tickets con dependencias (`/to-tickets`), crear uno por unidad y
declarar las dependencias en el cuerpo: prime-board todavía **no** tiene
relaciones blocking/blocked-by entre issues (quedó fuera del MVP).

## Cuando una skill dice "fetch the relevant ticket"

```bash
pb issue view AT-172 --json     # incluye descripción, comentarios y actividad
pb issue list --team AT --state "Ready for Agent" --json
```

## Cuando una skill dice "comment on the ticket"

```bash
pb issue comment AT-172 --body -
```

## Cambiar el estado de triage

```bash
pb issue update AT-172 --state "Ready for Agent"
```

## Wayfinding operations

Usado por `/wayfinder`. prime-board no tiene un concepto de "map" separado: el
**proyecto** hace de mapa y sus **milestones** ordenan las fases.

- **Map:** un proyecto (`pb project create --name "<effort>" --team AT`); las notas
  y decisiones van en su descripción.
- **Child ticket:** un issue del proyecto, opcionalmente asignado a un milestone.
- **Blocking:** se declara en el cuerpo del issue (sin soporte nativo todavía).
- **Frontier:** `pb issue list --team AT --state backlog --json`, filtrando por proyecto.
- **Claim:** `pb issue update <ID> --state "In Progress" --assignee me`.
- **Resolve:** `pb issue comment <ID> --body -` con la respuesta y luego
  `pb issue update <ID> --state done`.
