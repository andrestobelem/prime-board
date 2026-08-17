# Guía de uso para agentes

> Ticket: [AT-143](https://linear.app/andrestobelem/issue/AT-143/guia-de-uso-para-agentes-y-seeds-de-demo)
> Cómo operar prime-board de punta a punta siendo un agente (o un humano con terminal).

## 1. Levantar el server

```bash
bun install
bun run server
```

En un **workspace nuevo de desarrollo** el server siembra datos demo (team `PB`, actor `admin`); el workspace migrado opera con team `PRB`.
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
  Los agentes se identifican por un nombre operativo elegido por el equipo, no por el
  modelo o LLM que los ejecute; ese nombre puede cambiar sin rotar su key.
- **Identificadores legibles**: los issues operativos se referencian como `PRB-153` en toda la API.
- **Estados con tipo semántico**: cada team define sus estados, pero todos tienen un
  tipo portable (`triage|backlog|unstarted|started|completed|canceled`) — filtrá por
  tipo y tu código funciona en cualquier team.
- **Paridad total**: GraphQL, CLI y MCP pueden hacer exactamente lo mismo.

## 3. Darse de alta como agente

Con la key de admin, creá un actor con nombre operativo y su key (¡se muestra una sola vez!):

```bash
curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { actorCreate(input: { name: \"atlas\", type: AGENT }) { actor { id } } }"}'

curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { apiKeyCreate(input: { actorId: \"<ID>\", name: \"atlas key\" }) { key } }"}'
```

Para cambiar el nombre sin perder la identidad ni las keys del agente:

```bash
curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { actorUpdate(id: \"<ID>\", input: { name: \"nuevo-nombre\" }) { actor { id name } } }"}'
```

El `id` del actor es estable y las keys se asocian a ese id; por eso un renombrado no
rompe la autenticación ni la auditoría. Repetí `actorCreate` y `apiKeyCreate` para agregar
agentes adicionales.

## 4. GraphQL directo

Endpoint único: `POST /graphql` con `authorization: Bearer pb_...`.
GraphiQL disponible en `http://localhost:3333/graphql` (en dev).

La query estrella — _mis issues urgentes sin empezar que mencionen webhooks_:

```graphql
query ($me: ID!) {
  issues(
    filter: {
      assignee: { eq: $me }
      priority: { eq: 1 }
      stateType: { eq: UNSTARTED }
      search: "webhook"
    }
  ) {
    nodes {
      identifier
      title
      url
      branchName
    }
  }
}
```

### Semántica de `filter.search`

La búsqueda usa prefijos sobre tokens y frases exactas entre comillas. Una frase vacía
(`""`) se ignora, por lo que no restringe los resultados; `*` se trata como un token
literal y normalmente no devuelve resultados. Las comillas sin cerrar se tratan como
tokens literales, nunca como sintaxis FTS5. Estas entradas no exponen errores internos de SQLite
y conservan el comportamiento de filtros anidados y paginación.

Ciclo de vida completo: `issueCreate` → `issueUpdate` (estado/prioridad/assignee/labels/
parent/project) → `commentCreate` → `issueArchive`. Todo queda en `Issue.activity`.

## 5. CLI `pb`

```bash
alias pb="bun /ruta/a/prime-board/apps/cli/src/index.ts"

pb auth login --url http://localhost:3333 --key pb_xxx
pb issue list --team PRB --state started --assignee me --json
pb issue create --team PRB --title "Hacer algo" --priority high --label agent:review
pb issue update PRB-153 --state done
pb issue comment PRB-153 --body -   # el body por stdin
pb project view <id> --json
pb webhook create --url http://localhost:9999/hook --events issue.created
```

- `--json` en todo comando de lectura → salida estable para parsear.
- Exit codes: `0` ok, `1` error de API, `2` error de uso.
- Env `PRIME_BOARD_URL` / `PRIME_BOARD_API_KEY` pisan la config guardada.
- `pb auth login` guarda las credenciales en `~/.prime-board/cli.json`; el directorio queda
  con permisos `0700` y el archivo con `0600`. El CLI vuelve a endurecer esos permisos al
  cargar una configuración existente. No compartas ese archivo ni lo subas al repositorio.

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

El `secret` se muestra **una sola vez**, al crear el webhook: guardalo en el receptor.
Cada request lleva `X-PrimeBoard-Signature`, un HMAC-SHA256 en hexadecimal minúscula
calculado sobre el **body crudo exacto** (los bytes antes de parsearlo como JSON). No
reserialices el payload antes de verificar: cambios de espacios, orden de claves o saltos
de línea producen otra firma.

Ejemplo de verificación en Node:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, rawBody: string, received: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

// Verificá rawBody antes de hacer: const payload = JSON.parse(rawBody);
```

Los nombres de los headers HTTP no distinguen mayúsculas de minúsculas. Entrega con 3
reintentos y backoff (1s/5s/25s). Si tu receptor estuvo caído más que eso, reconstruí el
estado consultando la API (la actividad por issue es completa).

## 8. Exportar y reconstruir con seguridad

La DB es la fuente operativa y `.prime-board/` es su réplica versionada. No edites la
réplica a mano: exportá desde la DB y revisá los cambios antes de commitearlos.

```bash
bun run export                         # export completo a la raíz del repo
bun run export --team PRB --out /tmp/pb-export  # export parcial, con alcance registrado
bun run rebuild --from /ruta/prime-board       # reemplaza desde un export completo
bun run rebuild --from /tmp/pb-export --allow-partial  # reemplazo parcial explícito
```

`bun run rebuild` rechaza un export con `meta/export.json` de alcance `team:KEY` si no se
pasa `--allow-partial`. El flag no fusiona: confirma que se reemplazará el índice por el
alcance parcial y que los teams ausentes no se recuperan. No ejecutes `rebuild` sobre la
DB operativa sin revisar antes el export y contar con un backup.

Los exports no contienen API keys ni secretos de webhooks. El rebuild puede volver a
asociar keys locales por nombre de actor, pero la réplica nunca es un mecanismo para
transportar credenciales.

La receta anterior fue verificada contra una DB temporal: un export completo se reconstruye
con `--from`, un export `team:PRB` termina con error sin `--allow-partial` y se reconstruye
con éxito al pasar ese flag. La prueba no usa ni reemplaza la DB operativa.

## 9. Receta completa para un agente nuevo

```bash
bun run server &                 # 1. server corriendo (key de admin impresa)
bun run seed                     # 2. datos de demo + key de demo-agent
pb auth login --url http://localhost:3333 --key <key-del-agente>
pb issue list --team PRB --assignee me --json    # 3. mi cola de trabajo
pb issue update PRB-153 --state started            # 4. tomo el issue
pb issue comment PRB-153 --body "On it"            # 5. aviso
pb issue update PRB-153 --state done               # 6. entrego
```
