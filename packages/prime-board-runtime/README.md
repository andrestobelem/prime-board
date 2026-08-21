# `@prime-board/runtime`

Paquete de runtime distribuible de prime-board. La versión `0.1.0` requiere Bun `1.3.14`.
Se entrega como un tarball npm que contiene el servidor GraphQL, la UI estática, las
migraciones SQLite y el launcher. La DB y la réplica del repositorio quedan fuera del
paquete.

## Construcción e instalación

Desde el monorepo:

```bash
bun run build
npm pack
npm install /ruta/a/prime-board-runtime-0.1.0.tgz
```

El paquete no depende de `workspace:*` ni de paquetes privados de producción. Un entorno
limpio solo necesita Bun para ejecutar el binario instalado:

```bash
prime-board --db /tmp/prime-board.db --repo /ruta/al/proyecto --port 3333
```

`--repo` configura la Repository Replica del proyecto. No guardes API keys ni secretos en el
paquete o en `.prime-board/`.

## API y códigos de salida

El primer inicio imprime una API key administrativa una sola vez. Usa esa key (o una API key
normal) como Bearer para GraphQL. Las solicitudes sin Bearer reciben el error GraphQL
`UNAUTHORIZED`.

- `0`: `--help`.
- `1`: error al iniciar o ejecutar el servidor, o terminación por señal.
- `2`: argumentos CLI inválidos.

El launcher aislado por repositorio y los binarios standalone por plataforma se implementan
en tickets posteriores.
