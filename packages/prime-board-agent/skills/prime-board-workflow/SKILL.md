---
name: prime-board-workflow
description: Usar cuando el proyecto está conectado a una instancia aislada de prime-board, al crear o actualizar Issues PRB o al configurar el flujo CLI/MCP de prime-board.
---

# Flujo de prime-board

Usa la instancia aislada de prime-board del proyecto como tracker operativo. El repositorio
del proyecto y su réplica `.prime-board/` están separados del repositorio fuente de
prime-board.

## Activar la conexión

Usa estas variables de entorno:

- `PRIME_BOARD_URL`: URL del servidor del proyecto.
- `PRIME_BOARD_API_KEY`: API key del Actor actual.
- `PRIME_BOARD_TEAM`: clave del Team; descúbrela con `pb team list` si no está definida.
- `PRIME_BOARD_ROOT`: ruta al checkout de prime-board, necesaria para el CLI/MCP fuente.

Si el servidor no está ejecutándose, pide al humano que inicie una instancia aislada:

```bash
bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD"
```

El primer inicio imprime la admin API key una sola vez. Mantén esa clave fuera del repositorio.
Para obtener la configuración sin iniciar un servidor:

```bash
eval "$(bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD" --print-env)"
```

Después define `PRIME_BOARD_API_KEY` y autentica el CLI. La configuración detallada de CLI y
MCP está en [references/setup.md](references/setup.md).

## Ciclo de trabajo

1. **Busca o crea un Issue por unidad de trabajo.** Busca primero en el Team del proyecto para
   evitar duplicados. El trabajo nuevo pertenece al board del proyecto, no a Linear ni a una
   réplica `.prime-board/` editada a mano.
2. **Reclámalo antes de editar.** Mueve el Issue al estado activo y asígnalo al Actor actual.
3. **Implementa y valida.** Sigue `AGENTS.md`, los tests y las convenciones del proyecto.
   Registra como Issues separados los errores nuevos antes de corregirlos.
4. **Deja evidencia.** Comenta el Issue con el comportamiento entregado, los comandos usados y
   las brechas conocidas.
5. **Resuélvelo después de validar.** Muévelo al estado completado solo cuando pasen los
   criterios de aceptación y las regresiones.

Usa los comandos de [references/commands.md](references/commands.md). La API GraphQL es la
autoridad de autorización y estado; el CLI y MCP son adaptadores.
