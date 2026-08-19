# Validación de Bun.SQL con PostgreSQL

- **Fecha:** 2026-08-19
- **Ticket:** PRB-425
- **Runtime:** Bun 1.3.14
- **Driver:** `Bun.SQL` integrado en Bun
- **Servidor:** PostgreSQL 16 Alpine, contenedor efímero local

## Procedimiento

Se ejecutó `scripts/validate-bun-sql.ts` contra un PostgreSQL local levantado
con credenciales efímeras. La URL se recibió únicamente por
`PRIME_BOARD_POSTGRES_URL`; no se guardó ni se imprimió ningún secreto. El
contenedor y su volumen fueron temporales y se eliminaron al terminar la
validación.

El script comprueba URL, pool, parámetros interpolados, `RETURNING`, JSONB,
filas afectadas, rollback, errores, cierre y aislamiento de la conexión de una
transacción. La opción `max: 2` permite comprobar que una consulta concurrente
fuera de una transacción obtiene otra conexión mientras la transacción conserva
la suya.

## Resultado observado

La ejecución terminó con `passed: true`:

- `new Bun.SQL({ url, max, idleTimeout, maxLifetime, connectionTimeout })` se
  conecta correctamente.
- Los valores interpolados se parametrizan y un objeto JavaScript se inserta y
  recupera como JSONB.
- `INSERT ... RETURNING` devuelve una lista de filas.
- En Bun 1.3.14 el resultado de una sentencia sin filas expone `count` como la
  cantidad afectada; `affectedRows` aparece en la metadata pero queda `null`.
  El adaptador futuro debe normalizar `count` a `rowCount` del contrato, sin
  depender de `affectedRows`.
- `sql.begin(async tx => ...)` hace rollback cuando la callback lanza y reserva
  una conexión dedicada: la consulta concurrente observada usó otro backend
  PID.
- Los errores se rechazan como `PostgresError`. El código runtime observado
  para las sentencias inválidas/violaciones probadas fue
  `ERR_POSTGRES_SERVER_ERROR`; el adaptador debe conservar el error original
  como `cause` y no incluir SQL ni parámetros en mensajes normalizados.
- `sql.close({ timeout: 5 })` cierra el pool de forma awaitable.

## Configuración recomendada para el próximo adaptador

```ts
const sql = new Bun.SQL({
  url: process.env.PRIME_BOARD_POSTGRES_URL,
  max: 10,
  idleTimeout: 30,
  maxLifetime: 3600,
  connectionTimeout: 10,
});
```

Los límites son defaults operativos del adaptador, no valores que deban
quedar embebidos en el dominio. La URL y credenciales deben venir de un canal
de configuración protegido y nunca de `.prime-board/` ni de documentación
versionada.

## Fuentes primarias

- Bun SQL docs (`oven-sh/bun`, `docs/runtime/sql.mdx`): `Bun.SQL`, opciones de
  pool, `sql.begin`, `sql.reserve` y `sql.close`.
- Validación reproducible versionada en
  `scripts/validate-bun-sql.ts`.
