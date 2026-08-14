# prime-board

Clon de Linear para agentes: un gestor de issues y proyectos pensado para que lo
usen agentes — en principio [prime-agent](https://github.com/nicolaschapur/prime-agent),
aunque debería poder usarse con otros.

## Estado

**Parte 1 — Definición del MVP: completa.** El MVP quedó definido en
[`docs/alcance-mvp.md`](docs/alcance-mvp.md) y especificado en
[`docs/specs/mvp.md`](docs/specs/mvp.md): Bun + TypeScript + SQLite, API GraphQL,
local-first single-tenant, con CLI, MCP server y UI Linear-like.

**Parte 2 — Núcleo del backend: completa.** API GraphQL operativa sobre SQLite:
teams, actores humano/agente con API keys, issues con sub-issues y actividad,
labels, proyectos, filtros componibles + full-text (FTS5), paginación por cursor
y webhooks firmados con HMAC. 43 tests.

**Parte 3 — Interfaces para agentes: completa.** CLI `pb` (issues, proyectos,
teams, webhooks; `--json`, exit codes estables) y MCP server por stdio con las
mismas 14 tools que el MCP de Linear. Guía completa en
[`docs/guia-agentes.md`](docs/guia-agentes.md) y datos de demo con `bun run seed`.

**Próximo:** UI web Linear-like (Parte 4). Los tickets viven en Linear, proyecto
`prime-board` del workspace `andrestobelem`.

### Quick start

```bash
bun install
bun run server   # imprime la API key de admin en el primer arranque
# GraphQL en http://localhost:3333/graphql (GraphiQL en dev)
```

## Convenciones

Ver [`AGENTS.md`](AGENTS.md) para las convenciones del repo (idioma, commits, estructura).
