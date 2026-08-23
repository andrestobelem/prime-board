# `@prime-board/agent`

Paquete de [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) para prime-board.
Distribuye una extensión de lifecycle y diagnóstico, además de la skill
`prime-board-workflow`. No modifica la réplica `.prime-board/` directamente.

## Instalación local

Desde el checkout de prime-board:

```bash
prime-agent package install ./packages/prime-board-agent --local
```

También puedes instalarlo desde npm o Git cuando exista un release del paquete.

## Extensión

La extensión registra:

- `session_start`: descubre la raíz Git desde `ctx.cwd`, reutiliza o inicia el launcher aislado y espera `GET /health`.
- `session_shutdown`: libera la referencia de la sesión sin detener un runtime compartido.
- `/prime-board start|status|open|logs|stop|auth`: comandos finos de lifecycle y diagnóstico.
- `prime_board_status`: expone el estado del runtime como herramienta del agente.

El launcher se ejecuta con argumentos, nunca mediante un shell. Su lock por proyecto evita
procesos duplicados. Los logs se guardan fuera del repositorio, con secretos redactados y modo
`0600`. El package necesita `PRIME_BOARD_ROOT` cuando el checkout de prime-board no coincide con
el proyecto activo; la distribución del runtime standalone pertenece a PRB-451.

## Skill

Invoca `/skill:prime-board-workflow` para ejecutar el flujo operativo: activar la instancia
aislada, buscar y reclamar Issues, implementar y validar, dejar evidencia y resolver. El mismo
recurso instala la skill Python `prime_board_workflow`, que diagnostica la conexión y delega
`list_tools`/`call_tool` al MCP HTTP autenticado. No duplica mutaciones GraphQL. Mantén las
credenciales (`PRIME_BOARD_API_KEY`) fuera del paquete y del repositorio; `/prime-board auth`
verifica o crea un Actor `AGENT` por proyecto y guarda solo su credencial en
`~/.prime-board/credentials/` con modo `0600`.

## MCP HTTP

El transporte principal es el adaptador Streamable HTTP existente en `apps/mcp/src/http.ts`.
Inícialo con `PRIME_BOARD_MCP_URL` por proyecto o registra un servidor MCP con un bearer env var.
El package no incluye todavía un binario MCP standalone. Una instalación limpia necesita el
checkout de prime-board y Bun hasta que PRB-451 publique el runtime distribuible.
