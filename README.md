# prime-board

Clon de Linear para agentes: un gestor de issues y proyectos pensado para que lo
usen agentes — en principio [prime-agent](https://github.com/nicolaschapur/prime-agent),
aunque debería poder usarse con otros.

## Estado

**Parte 1 — Definición del MVP: completa.** El MVP quedó definido en
[`docs/alcance-mvp.md`](docs/alcance-mvp.md) y especificado en
[`docs/specs/mvp.md`](docs/specs/mvp.md): Bun + TypeScript + SQLite, API GraphQL,
local-first single-tenant, con CLI, MCP server y UI Linear-like.

**Próximo:** implementación en tres hitos — núcleo del backend (Parte 2), interfaces
para agentes (Parte 3) y UI web (Parte 4). Los tickets viven en Linear, proyecto
`prime-board` del workspace `andrestobelem`.

## Convenciones

Ver [`AGENTS.md`](AGENTS.md) para las convenciones del repo (idioma, commits, estructura).
