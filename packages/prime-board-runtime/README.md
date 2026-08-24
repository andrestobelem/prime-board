# `@prime-board/runtime`

Paquete de runtime distribuible de prime-board. La versión `0.1.0` requiere Bun `1.3.14` o
posterior. La primera entrega distribuye un paquete npm portable con servidor y UI; no publica
binarios nativos. La matriz de plataforma es la matriz de Bun soportada por el usuario:

| Plataforma | Arquitectura | Estado    | Dependencia   |
| ---------- | ------------ | --------- | ------------- |
| macOS      | arm64, x64   | soportada | Bun >= 1.3.14 |
| Linux      | x64, arm64   | soportada | Bun >= 1.3.14 |
| Windows    | x64, arm64   | soportada | Bun >= 1.3.14 |

La aplicación no depende de `workspace:*` ni de paquetes privados de producción. El servidor,
la UI y las migraciones se incluyen en `dist/`. `dist/manifest.json` contiene SHA-256 por
archivo y `dist/checksums.txt` permite comprobar el artefacto después de descargarlo.

## Construcción e instalación

Desde el monorepo:

```bash
bun install --frozen-lockfile
bun run build:runtime
cd packages/prime-board-runtime
npm pack
npm install /ruta/a/prime-board-runtime-0.1.0.tgz
```

Una instalación limpia solo necesita Bun para ejecutar el binario instalado:

```bash
prime-board --project /ruta/al/proyecto
```

El runtime resuelve la raíz Git del proyecto, usa una DB en
`~/.prime-board/projects/<slug>-<hash>.db`, crea un lock en el mismo directorio y espera
`GET /health` antes de imprimir `prime-board ready`. Dos procesos para el mismo proyecto
reutilizan la instancia existente. Un `--db` explícito nunca se cambia en silencio; si otra
instancia ya usa ese proyecto o esa DB, el launcher falla.

Opciones principales:

```text
--project PATH   Proyecto Git (por defecto, el directorio actual)
--db PATH        DB SQLite fuera del paquete
--port PORT      Puerto; el valor implícito busca el siguiente puerto libre
--host HOST      Bind explícito; por defecto 127.0.0.1
--web-dist PATH  UI alternativa
--status         Estado sin iniciar
--print-env      Variables para un cliente local sin iniciar
```

El launcher usa argumentos, no un shell. El lock y la reserva de DB registran el PID del server
hijo después del handoff. También registran el grupo de procesos y una identidad de instancia. Así,
SIGKILL sobre el launcher no permite iniciar otro server mientras el hijo huérfano siga saludable.
Las señales `SIGINT` y `SIGTERM` se reenvían al server y liberan el lock, la reserva de DB y la
reserva de puerto. `--status` conserva los códigos `0` (running), `1` (not-running) y `2`
(stale). El estado operativo no se escribe en el package: SQLite queda fuera de `dist/` y
`PRIME_BOARD_REPO` apunta a la Repository Replica del proyecto (`.prime-board/`). La réplica se
genera por la API y no contiene API keys ni secretos de webhooks. Los logs de una extensión deben
guardarse fuera del proyecto con modo `0600` y redacción de bearer/API keys.

El bind predeterminado es loopback. `--host` permite un override explícito. El modo
`PRIME_BOARD_AUTH_MODE=local` mantiene loopback aunque se configure otro host; usa API-key mode
solo cuando se necesita un bind externo controlado.

## Credenciales y bootstrap

El primer bootstrap solo persiste hashes en SQLite. La API key administrativa se muestra una vez
en la salida interactiva del servidor y no se copia al package, a la réplica ni a archivos de
log del agente. Guarda la key en un almacén externo con modo `0600`. Para una instancia local,
`PRIME_BOARD_AUTH_MODE=local` evita la necesidad de una key.

## Actualizaciones y rollback

Las migraciones SQLite son versionadas y se ejecutan dentro de transacciones. El runtime activa
`PRAGMA journal_mode = WAL` y `PRAGMA foreign_keys = ON` antes de migrar. El runner no tiene
migraciones destructivas automáticas hacia atrás. Antes de actualizar:

1. Detén el runtime y copia `<db>`, `<db>-wal` y `<db>-shm` o ejecuta un backup SQLite consistente.
2. Guarda la versión del package y verifica `dist/checksums.txt`.
3. Instala el nuevo package y arráncalo para aplicar migraciones.
4. Si el arranque o el health-check falla, detén el proceso, reinstala la versión anterior y
   restaura la copia de seguridad de los tres archivos SQLite. No borres la réplica Git.

El archivo `dist/manifest.json` registra la versión del formato, el backend y los checksums del
artefacto. PostgreSQL no forma parte de este runtime instalable; su migración sigue siendo
opcional y separada.
