# Runbook local de PostgreSQL con Podman

- **Ticket:** PRB-426
- **Imagen por defecto:** `docker.io/library/postgres:17`
- **Alcance:** desarrollo y validación local; no es un procedimiento de producción.

## Arranque

El comando versionado crea una red y un volumen con nombre, guarda la contraseña en un secreto de Podman e inicia PostgreSQL solo en loopback:

```bash
scripts/postgres-dev.sh up
```

La primera ejecución solicita la contraseña sin mostrarla. En automatización, proporciona `PB_PG_PASSWORD` mediante un canal de secretos del runner. Nunca la pases como argumento ni la escribas en el repositorio. Aísla los nombres y el puerto por entorno:

```bash
PB_PG_CONTAINER=prime-board-postgres \
PB_PG_NETWORK=prime-board \
PB_PG_VOLUME=prime-board-pgdata \
PB_PG_SECRET=prime-board-pg-password \
PB_PG_PORT=5432 \
scripts/postgres-dev.sh up
```

La aplicación en el host usa `127.0.0.1:${PB_PG_PORT}`. Un contenedor conectado a `PB_PG_NETWORK` usa `PB_PG_CONTAINER:5432`. El script no publica PostgreSQL en interfaces externas. Usa `pg_isready` como healthcheck y espera readiness antes de terminar.

## Verificación y ciclo de vida

```bash
scripts/postgres-dev.sh status
scripts/postgres-dev.sh check
scripts/postgres-dev.sh down
```

`check` ejecuta una query real con el rol configurado. `down` conserva el volumen y el secreto para que el siguiente `up` mantenga los datos. Para borrar recursos, ejecuta una operación explícita de Podman y verifica antes un backup. El script no destruye recursos por accidente.

## Backup y restore

El backup usa el formato custom de `pg_dump`, permisos locales `0600` y no incluye
credenciales:

```bash
PB_PG_BACKUP="$PWD/.scratch/prime-board.dump" scripts/postgres-dev.sh backup
PB_PG_BACKUP="$PWD/.scratch/prime-board.dump" scripts/postgres-dev.sh restore
PB_PG_BACKUP="$PWD/.scratch/prime-board.dump" scripts/postgres-dev.sh check
```

Mantén el directorio `.scratch/` fuera de Git. `restore` usa el rol local `postgres` del contenedor para ejecutar `pg_restore` y conecta al nombre de la base configurada. No necesita imprimir ni transportar la contraseña.

## Validación ejecutada

El equipo probó el flujo completo con nombres, puerto, secreto, volumen y red efímeros:

1. `up` creó los recursos y esperó `pg_isready`.
2. `status` mostró el contenedor `running` con imagen major `17`.
3. `check` devolvió `PostgreSQL query check: OK`.
4. `backup` creó un dump custom y `restore` lo aplicó correctamente.
5. `check` volvió a pasar y se eliminaron contenedor, red, volumen, secreto y
   máquina Podman de la validación.

El repositorio no versiona dumps, URLs ni credenciales.
