# Configuración aislada del proyecto

## 1. Iniciar la instancia

Desde el checkout clonado de prime-board:

```bash
bun scripts/prime-board-project.ts --project /ruta/al/proyecto
```

El comando deriva una base aislada bajo `~/.prime-board/projects/`, define `PRIME_BOARD_REPO`
para el repositorio objetivo e inicia el servidor en el puerto 3333. Sobrescribe `--port` o
`--db` cuando sea necesario. El servidor escribe la réplica `.prime-board/` del proyecto;
no edites ese directorio directamente.

Para inspeccionar la configuración sin iniciar un servidor:

```bash
eval "$(bun scripts/prime-board-project.ts --project /ruta/al/proyecto --print-env)"
```

La admin key se imprime una sola vez durante el primer inicio. Crea un Actor y una API key
normal, y exporta esta última como `PRIME_BOARD_API_KEY`.

## 2. Instalar el package en el proyecto objetivo

Desde el checkout de prime-board, instala el package en la configuración local de Prime Agent:

```bash
prime-agent package install /ruta/a/prime-board/packages/prime-board-agent --local
```

La instalación descubre la extensión y la skill declaradas en `package.json.pi`; no hace falta
copiar manualmente desde `.agents/skills`. Las convenciones del proyecto siguen teniendo
autoridad en su `AGENTS.md`.

## 3. Configurar el CLI

```bash
export PRIME_BOARD_ROOT=/ruta/a/prime-board
export PRIME_BOARD_URL=http://localhost:3333
export PRIME_BOARD_API_KEY=pb_...
export PRIME_BOARD_TEAM=PRB
alias pb='bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts"'
pb issue list --team "$PRIME_BOARD_TEAM" --json
```

## 4. Configurar MCP HTTP (interfaz principal)

Inicia el transporte local en otra terminal. El servidor MCP no lee una API key del entorno:
valida el Bearer enviado por cada cliente.

```bash
PRIME_BOARD_URL=http://localhost:3333 \
PRIME_BOARD_MCP_HOST=127.0.0.1 \
PRIME_BOARD_MCP_PORT=3334 \
bun "$PRIME_BOARD_ROOT/apps/mcp/src/http.ts"
```

Configura el cliente MCP con el endpoint y el header Bearer, sin guardar la clave en el package:

```json
{
  "mcpServers": {
    "prime-board": {
      "type": "http",
      "url": "http://127.0.0.1:3334/mcp",
      "bearerTokenEnvVar": "PRIME_BOARD_API_KEY"
    }
  }
}
```

El transporte stdio existente continúa disponible para clientes que aún no soportan HTTP:
usa `bun "$PRIME_BOARD_ROOT/apps/mcp/src/index.ts"` con `PRIME_BOARD_URL` y
`PRIME_BOARD_API_KEY` en el entorno del proceso, nunca en el package ni en `.prime-board/`.

Para varios proyectos, ejecuta una instancia por proyecto con una base y un puerto distintos.
Nunca reutilices una base entre proyectos.
