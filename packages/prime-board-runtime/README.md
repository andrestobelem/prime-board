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
--backup PATH    Crear un backup verificado y salir
--restore PATH   Restaurar un backup verificado con la instancia detenida
--update         Iniciar una versión nueva después del backup
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

El primer bootstrap solo persiste hashes en SQLite. La API key administrativa se guarda fuera del proyecto, con permisos `0600`, y no se imprime
en la salida interactiva del servidor y no se copia al package, a la réplica ni a archivos de
log del agente. Guarda la key en un almacén externo con modo `0600`. Para una instancia local,
`PRIME_BOARD_AUTH_MODE=local` evita la necesidad de una key.

## Actualizaciones y rollback

El launcher no actualiza una instancia viva. `prime-board` sin acción explícita reutiliza una
instancia saludable y no inicia un segundo escritor. Para aplicar una versión nueva, detén la
instancia y ejecuta `prime-board --update`. Si la instancia sigue viva, el comando falla antes de
abrir la DB.

Antes de iniciar el servidor con una DB existente, el launcher reserva la DB y crea un artefacto
fuera del package:

```text
~/.prime-board/backups/<project>-<hash>/<timestamp>-<id>.sqlite
~/.prime-board/backups/<project>-<hash>/<timestamp>-<id>.sqlite.json
```

El backup usa `VACUUM INTO` de SQLite desde una conexión de solo lectura. No copia `<db>-wal` ni
`<db>-shm`. SQLite crea una imagen autocontenida con las transacciones confirmadas. El launcher
abre esa imagen, ejecuta `integrity_check` y `foreign_key_check`, calcula SHA-256 y escribe el
archivo y sus metadatos con reemplazo atómico. La DB y los metadatos tienen modo `0600`. El
metadato registra la versión del runtime, la versión de Bun, la plataforma, la arquitectura, la
versión de migración, la ruta de la DB y la identidad del proyecto.

Puedes crear un backup manual sin iniciar el servidor:

```bash
prime-board --project /ruta/al/proyecto \
  --db /ruta/segura/board.sqlite \
  --backup /ruta/segura/board-before-update.sqlite
```

El comando escribe `board-before-update.sqlite.json`. La ruta de destino no puede ser la DB, un
sidecar WAL ni `.prime-board/`. Para restaurar, la instancia debe estar detenida:

```bash
prime-board --project /ruta/al/proyecto \
  --db /ruta/segura/board.sqlite \
  --restore /ruta/segura/board-before-update.sqlite
```

El restore comprueba el checksum, la integridad SQLite y la identidad del proyecto y de la DB.
Primero mueve la DB actual a un nombre temporal, instala la imagen verificada con `rename` y la
vuelve a validar. Si la sustitución o la validación falla, devuelve la DB original. Las reservas
de la DB impiden que dos proyectos escriban la misma ruta.

Si la migración o el health-check inicial fallan, el launcher detiene el server y restaura el
backup que acaba de crear. Si no puede confirmar que el server terminó, no toca la DB y conserva
el backup para una restauración manual. Un arranque de una DB nueva no crea backup; si falla antes
del health-check, elimina solo esa DB nueva y sus sidecars. La réplica `.prime-board/` del proyecto
no es parte del update y nunca se borra ni se sobrescribe.

El flujo necesita una ruta de backup escribible. No protege cambios sin commit de otra conexión y
no sustituye una copia externa de largo plazo. Conserva los artefactos hasta verificar el arranque
con la nueva versión. PostgreSQL no usa este flujo; PRB-458 solo cubre el runtime SQLite.

El archivo `dist/manifest.json` registra la versión del package, el backend SQLite, Bun mínimo y
los SHA-256 de cada archivo. `dist/checksums.txt` contiene la misma lista para validar el artefacto
antes de instalarlo.
