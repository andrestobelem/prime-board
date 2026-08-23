---
name: prime-board-workflow
description: Usar cuando el proyecto está conectado a una instancia aislada de prime-board, al crear o actualizar Issues PRB o al configurar el flujo CLI/MCP de prime-board. Incluye diagnóstico Python y acceso MCP autenticado.
---

# Flujo de prime-board

Usa la instancia aislada de prime-board del proyecto como gestor operativo de Issues. El
repositorio del proyecto y su réplica `.prime-board/` están separados del repositorio fuente de
prime-board.

## Recargar la instalación

Después de instalar o actualizar el package, ejecuta `/reload`. Prime Agent llama
`session_shutdown` y `session_start`; la segunda fase verifica el runtime existente y no crea un
segundo proceso. Para cambiar de proyecto, inicia una sesión nueva desde su checkout.

## Activar la conexión

Define estas variables de entorno:

- `PRIME_BOARD_URL`: URL del servidor del proyecto.
- `PRIME_BOARD_API_KEY`: API key del Actor actual.
- `PRIME_BOARD_TEAM`: clave del Team. Si no está definida, descúbrela con `pb team list`.
- `PRIME_BOARD_ROOT`: ruta al checkout de prime-board. El CLI/MCP fuente necesita esta ruta.

Si el servidor no está ejecutándose, pide al humano que inicie una instancia aislada con:

```bash
bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD"
```

El primer inicio imprime la admin API key una sola vez. Mantén esa clave fuera del repositorio.
Para configurar el entorno sin iniciar el servidor, ejecuta:

```bash
eval "$(bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD" --print-env)"
```

Después define `PRIME_BOARD_API_KEY` y autentica el CLI. Consulta [references/setup.md](references/setup.md)
para la configuración detallada del CLI y MCP.

## Ciclo de trabajo

1. **Busca o crea un Issue por unidad de trabajo.** Busca primero en el Team del proyecto para
   evitar duplicados. El trabajo nuevo pertenece al board del proyecto, no a Linear ni a una
   réplica `.prime-board/` editada a mano.
2. **Reclámalo antes de editar.** Mueve el Issue al estado activo y asígnalo al Actor actual.
3. **Implementa y valida.** Sigue `AGENTS.md`, los tests y las convenciones del proyecto.
   Crea un Issue separado para cada error nuevo antes de corregirlo.
4. **Deja evidencia.** Comenta el Issue con el comportamiento entregado, los comandos usados y
   las brechas conocidas.
5. **Resuélvelo después de validar.** Muévelo al estado completado solo cuando pasen los
   criterios de aceptación y las comprobaciones de regresión.

Usa los comandos de [references/commands.md](references/commands.md). La API GraphQL es la
autoridad para la autorización y el estado. El CLI y MCP son adaptadores.

## Skill Python de diagnóstico y MCP

El package también instala `prime_board_workflow` en el kernel Python de Prime Agent. No
replica las mutaciones GraphQL: descubre y llama las tools que expone el servidor MCP.

```python
import prime_board_workflow
await prime_board_workflow("diagnose")
await prime_board_workflow("list_tools")
await prime_board_workflow.call_tool("list_issues", {"team": "PRB"})
```

La skill resuelve el Git root desde el directorio actual. Busca primero `PRIME_BOARD_API_KEY`;
si no existe, lee la credencial del proyecto en
`~/.prime-board/credentials/<project-hash>.json`, con permisos `0600`. El endpoint y la
credencial nunca se escriben en `settings.json` ni en `.prime-board/`. Si no hay credencial,
`diagnose` y `list_tools` devuelven un resultado `unauthenticated` con una guía de configuración.
Los fallos de transporte devuelven un estado estable y hacen un intento de reconexión.

La skill necesita una sesión MCP Streamable HTTP en `/mcp` y una variable
`PRIME_BOARD_MCP_URL` por proyecto; consulta [references/setup.md](references/setup.md). Si el
endpoint no está configurado, devuelve `unconfigured` y no intenta usar `/mcp` en el servidor
GraphQL. Las operaciones de escritura siguen siendo las
tools MCP/GraphQL existentes. No uses esta skill para enviar consultas GraphQL arbitrarias.
