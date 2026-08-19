# Runbook local de PostgreSQL con Podman

- **Ticket:** PRB-426
- **Imagen por defecto:** `docker.io/library/postgres:17`
- **Alcance:** desarrollo y validación local; no es un procedimiento de producción.

## Arranque

El comando versionado crea una red y un volumen nombrados, guarda la contraseña en
un secreto de Podman y arranca PostgreSQL solo en loopback:

```bash
scripts/postgres-dev.sh up
```

La primera ejecución solicita la contraseña sin mostrarla. En automatización se
puede proporcionar `PB_PG_PASSWORD` por un canal de secretos del runner; nunca se
pasa como argumento ni se escribe en el repositorio. Los nombres y el puerto se
pueden aislar por entorno:

```bash
PB_PG_CONTAINER=prime-board-postgres \
PB_PG_NETWORK=prime-board \
PB_PG_VOLUME=prime-board-pgdata \
PB_PG_SECRET=prime-board-pg-password \
PB_PG_PORT=5432 \
scripts/postgres-dev.sh up
```

La aplicación en el host usa `127.0.0.1:${PB_PG_PORT}`. Un contenedor conectado a
`PB_PG_NETWORK` usa `PB_PG_CONTAINER:5432`; no se publica PostgreSQL en interfaces
externas. El healthcheck usa `pg_isready` y el script espera readiness antes de
terminar.

## Verificación y ciclo de vida

```bash
scripts/postgres-dev.sh status
scripts/postgres-dev.sh check
scripts/postgres-dev.sh down
```

`check` ejecuta una consulta real con el rol configurado. `down` conserva el
volumen y el secreto para que el siguiente `up` mantenga los datos. Para borrar
los recursos se requiere una operación explícita de Podman y un backup verificado
previamente; el script no ejecuta esa destrucción accidentalmente.

## Backup y restore

El backup usa el formato custom de `pg_dump`, permisos locales `0600` y no incluye
credenciales:

```bash
PB_PG_BACKUP="$PWD/.scratch/prime-board.dump" scripts/postgres-dev.sh backup
PB_PG_BACKUP="$PWD/.scratch/prime-board.dump" scripts/postgres-dev.sh restore
PB_PG_BACKUP="$PWD/.scratch/prime-board.dump" scripts/postgres-dev.sh check
```

El directorio `.scratch/` debe permanecer fuera de git. `restore` usa el rol local
`postgres` del contenedor para ejecutar `pg_restore`, pero conecta al nombre de la
base configurada; no necesita imprimir ni transportar la contraseña.

## Validación ejecutada

Se probó el flujo completo con nombres, puerto, secreto, volumen y red efímeros:

1. `up` creó los recursos y esperó `pg_isready`.
2. `status` mostró el contenedor `running` con imagen major `17`.
3. `check` devolvió `PostgreSQL query check: OK`.
4. `backup` creó un dump custom y `restore` lo aplicó correctamente.
5. `check` volvió a pasar y se eliminaron contenedor, red, volumen, secreto y
   máquina Podman de la validación.

No se versionan dumps, URLs ni credenciales.
