# Configuración aislada del proyecto

## 1. Iniciar la instancia

Desde el checkout clonado de prime-board:

```bash
bun scripts/prime-board-project.ts --project /ruta/al/proyecto
```

El comando deriva una base aislada bajo `~/.prime-board/projects/`, define `PRIME_BOARD_REPO`
para el repositorio objetivo e inicia el servidor en el puerto 3333. En una base nueva puedes
elegir la identidad inicial con `--workspace-name`, `--workspace-url-key`, `--team-name` y
`--team-key`. Las variables equivalentes son `PRIME_BOARD_WORKSPACE_NAME`,
`PRIME_BOARD_WORKSPACE_URL_KEY`, `PRIME_BOARD_TEAM_NAME` y `PRIME_BOARD_TEAM_KEY`; los flags
preceden a las variables. Los defaults son `workspace`, `prime-board`, `Prime Board` y `PB`.
La identidad solo se aplica en el primer bootstrap. `urlKey` usa minúsculas, números y guiones.
La `key` del Team tiene entre 1 y 8 caracteres alfanuméricos y comienza con una letra. Usa
`--port` o `--db` para cambiar estos valores cuando sea necesario. El servidor escribe la réplica
`.prime-board/` del proyecto. No edites ese directorio directamente.

Para inspeccionar la configuración sin iniciar el servidor, ejecuta:

```bash
eval "$(bun scripts/prime-board-project.ts --project /ruta/al/proyecto --print-env)"
```

La admin key se imprime una sola vez durante el primer inicio. Define esa clave solo para
`/prime-board auth` o para el bootstrap inicial. La extensión crea un Actor `AGENT` por proyecto,
crea una API key limitada al Team y guarda solo esa credencial verificada. Después exporta la clave
AGENT como `PRIME_BOARD_API_KEY` para el trabajo normal.

## 2. Instalar el package en el proyecto objetivo

Desde el checkout de prime-board, instala el package en la configuración local de Prime Agent:

```bash
prime-agent package install /ruta/a/prime-board/packages/prime-board-agent --local
```

La instalación descubre la extensión y la skill declaradas en `package.json.pi`. No necesitas
copiar archivos manualmente desde `.agents/skills`. Las convenciones del proyecto mantienen la
autoridad en su `AGENTS.md`.

## 3. Guardar una credencial por proyecto (opcional)

La extensión puede guardar la API key activa fuera del repositorio:

```text
/prime-board auth
```

El comando solo lee `PRIME_BOARD_API_KEY` del entorno del proceso. Escribe un archivo con
permisos `0600` bajo `~/.prime-board/credentials/`. También puedes omitir este paso y mantener
la key únicamente en el entorno de cada proceso. Nunca pegues una key en `settings.json`, en
`.prime-board/` ni en un comentario del Issue.

## 4. Configurar el CLI

```bash
export PRIME_BOARD_ROOT=/ruta/a/prime-board
export PRIME_BOARD_URL=http://localhost:3333
export PRIME_BOARD_API_KEY=pb_...
export PRIME_BOARD_MCP_URL=http://127.0.0.1:3334/mcp
export PRIME_BOARD_TEAM=PRB
alias pb='bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts"'
pb issue list --team "$PRIME_BOARD_TEAM" --json
```

## 5. Configurar MCP HTTP (interfaz principal)

Inicia el transporte local en otra terminal. El servidor MCP no lee una API key del entorno.
Configura `PRIME_BOARD_MCP_URL` en el proceso de Prime Agent para que la skill use el endpoint
correcto y no intente `/mcp` en el servidor GraphQL.
Valida el Bearer que envía cada cliente.

```bash
PRIME_BOARD_URL=http://localhost:3333 \
PRIME_BOARD_MCP_HOST=127.0.0.1 \
PRIME_BOARD_MCP_PORT=3334 \
bun "$PRIME_BOARD_ROOT/apps/mcp/src/http.ts"
```

Configura el cliente MCP con el endpoint y el header Bearer. No guardes la clave en el package:

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

El transporte stdio existente sigue disponible para clientes que aún no soportan HTTP. Usa
`bun "$PRIME_BOARD_ROOT/apps/mcp/src/index.ts"` con `PRIME_BOARD_URL` y
`PRIME_BOARD_API_KEY` en el entorno del proceso. Nunca guardes estas variables en el package ni
en `.prime-board/`.

Para varios proyectos, ejecuta una instancia por proyecto, con una base y un puerto distintos.
Nunca reutilices una base entre proyectos. La extensión conserva el endpoint de cada instancia
en la credencial por proyecto; la skill resuelve ese archivo desde el Git root. Ejecuta un
servidor MCP HTTP por proyecto cuando los puertos no sean compartidos:

```bash
PRIME_BOARD_URL=http://127.0.0.1:<board-port> \
PRIME_BOARD_MCP_PORT=<mcp-port> \
PRIME_BOARD_API_KEY="$PRIME_BOARD_API_KEY" \
bun "$PRIME_BOARD_ROOT/apps/mcp/src/http.ts"
```
