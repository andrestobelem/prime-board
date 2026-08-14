# Guía de uso para agentes

> Ticket: [AT-143](https://linear.app/andrestobelem/issue/AT-143/guia-de-uso-para-agentes-y-seeds-de-demo)
> Cómo operar prime-board de punta a punta siendo un agente (o un humano con terminal).

## 1. Levantar el server

```bash
bun install
bun run server
```

En el **primer arranque** el server siembra el workspace (team `PB`, actor `admin`)
e imprime la API key de admin **una única vez**:

```
First run: workspace seeded.
Admin API key (save it now, it will not be shown again): pb_xxxxxxxx
prime-board server listening on http://localhost:3333
```

Config por env: `PRIME_BOARD_PORT` (default 3333) y `PRIME_BOARD_DB`
(default `~/.prime-board/prime-board.db`).

### Datos de demo (opcional)

```bash
bun run seed
```

Crea un proyecto, 4 issues (con sub-issue, labels, comentarios) y un actor
`demo-agent` con su propia API key — ideal para probar los clientes. Es idempotente:
si ya hay issues, no hace nada.

## 2. Conceptos en 30 segundos

- **Actores**: humanos y agentes son iguales ante la API (`type: HUMAN | AGENT`).
  Cada uno tiene su **API key** (`pb_...`) y toda acción queda atribuida a quien la hizo.
- **Identificadores legibles**: los issues se referencian como `PB-1` en toda la API.
- **Estados con tipo semántico**: cada team define sus estados, pero todos tienen un
  tipo portable (`triage|backlog|unstarted|started|completed|canceled`) — filtrá por
  tipo y tu código funciona en cualquier team.
- **Paridad total**: GraphQL, CLI y MCP pueden hacer exactamente lo mismo.

## 3. Darse de alta como agente

Con la key de admin, creá tu actor y tu key (¡se muestra una sola vez!):

```bash
curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { actorCreate(input: { name: \"mi-agente\", type: AGENT }) { actor { id } } }"}'

curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { apiKeyCreate(input: { actorId: \"<ID>\", name: \"mi key\" }) { key } }"}'
```

## 4. GraphQL directo

Endpoint único: `POST /graphql` con `authorization: Bearer pb_...`.
GraphiQL disponible en `http://localhost:3333/graphql` (en dev).

La query estrella — *mis issues urgentes sin empezar que mencionen webhooks*:

```graphql
query($me: ID!) {
  issues(filter: {
    assignee: { eq: $me }
    priority: { eq: 1 }
    stateType: { eq: UNSTARTED }
    search: "webhook"
  }) {
    nodes { identifier title url branchName }
  }
}
```

Ciclo de vida completo: `issueCreate` → `issueUpdate` (estado/prioridad/assignee/labels/
parent/project) → `commentCreate` → `issueArchive`. Todo queda en `Issue.activity`.

## 5. CLI `pb`

```bash
alias pb="bun /ruta/a/prime-board/apps/cli/src/index.ts"

pb auth login --url http://localhost:3333 --key pb_xxx
pb issue list --team PB --state started --assignee me --json
pb issue create --team PB --title "Hacer algo" --priority high --label agent:review
pb issue update PB-1 --state done
pb issue comment PB-1 --body -   # el body por stdin
pb project view <id> --json
pb webhook create --url http://localhost:9999/hook --events issue.created
```

- `--json` en todo comando de lectura → salida estable para parsear.
- Exit codes: `0` ok, `1` error de API, `2` error de uso.
- Env `PRIME_BOARD_URL` / `PRIME_BOARD_API_KEY` pisan la config guardada.

## 6. MCP

El server MCP habla stdio y expone **las mismas tools que el MCP de Linear**
(`list_issues`, `save_issue`, `save_comment`, `get_workspace`, ...): si tu agente ya
sabe operar Linear, opera prime-board sin aprender nada.

Config para un cliente MCP (Claude Desktop, prime-agent, etc.):

```json
{
  "mcpServers": {
    "prime-board": {
      "command": "bun",
      "args": ["/ruta/a/prime-board/apps/mcp/src/index.ts"],
      "env": {
        "PRIME_BOARD_URL": "http://localhost:3333",
        "PRIME_BOARD_API_KEY": "pb_xxx"
      }
    }
  }
}
```

## 7. Webhooks: enterarse de las cosas

Registrá una URL y recibí un POST por cada evento
(`issue.created`, `issue.updated`, `issue.archived`, `comment.created`,
`project.created`, `project.updated`):

```bash
pb webhook create --url http://localhost:9999/hook --events issue.created,comment.created
# imprime el signing secret UNA vez
```

Payload: `{ event, actor: {id,name,type}, data, changes?, createdAt }` —
en `issue.updated`, `changes` trae `{ campo: { from, to } }`.

Verificación de la firma (header `X-PrimeBoard-Signature`, HMAC-SHA256 hex del body):

```ts
import { createHmac } from "node:crypto";

function verify(secret: string, body: string, signature: string): boolean {
  return createHmac("sha256", secret).update(body).digest("hex") === signature;
}
```

Entrega con 3 reintentos y backoff (1s/5s/25s). Si tu receptor estuvo caído más que
eso, reconstruí el estado consultando la API (la actividad por issue es completa).

## 8. Receta completa para un agente nuevo

```bash
bun run server &                 # 1. server corriendo (key de admin impresa)
bun run seed                     # 2. datos de demo + key de demo-agent
pb auth login --url http://localhost:3333 --key <key-del-agente>
pb issue list --team PB --assignee me --json    # 3. mi cola de trabajo
pb issue update PB-1 --state started            # 4. tomo el issue
pb issue comment PB-1 --body "On it"            # 5. aviso
pb issue update PB-1 --state done               # 6. entrego
```
