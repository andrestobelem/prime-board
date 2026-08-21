# Validación de Bun.SQL con PostgreSQL

- **Fecha:** 2026-08-19
- **Ticket:** PRB-425
- **Runtime:** Bun 1.3.14
- **Driver:** `Bun.SQL` integrado en Bun
- **Servidor:** PostgreSQL 16 Alpine, contenedor efímero local

## Procedimiento

El equipo ejecutó `scripts/validate-bun-sql.ts` contra un PostgreSQL local con credenciales efímeras. El proceso recibió la URL solo mediante `PRIME_BOARD_POSTGRES_URL`; no guardó ni imprimió secretos. El equipo eliminó el contenedor y su volumen al terminar la validación.

El script comprueba la URL, el pool, los parámetros interpolados, `RETURNING`, JSONB, filas afectadas, rollback, errores, cierre y aislamiento de la conexión de una transacción. `max: 2` permite verificar que una query concurrente fuera de una transacción obtiene otra conexión mientras la transacción conserva la suya.

## Resultado observado

La ejecución terminó con `passed: true` y produjo estos resultados:

- `new Bun.SQL({ url, max, idleTimeout, maxLifetime, connectionTimeout })` se
  conecta correctamente.
- Bun parametriza los valores interpolados y permite insertar y recuperar un objeto JavaScript como JSONB.
- `INSERT ... RETURNING` devuelve una lista de filas.
- En Bun 1.3.14 el resultado de una sentencia sin filas expone `count` como la
  cantidad afectada; `affectedRows` aparece en la metadata pero queda `null`.
  El adaptador futuro debe normalizar `count` a `rowCount` del contrato, sin
  depender de `affectedRows`.
- `sql.begin(async tx => ...)` hace rollback cuando la callback lanza y reserva una conexión dedicada. La query concurrente observada usó otro backend PID.
- Bun rechaza los errores como `PostgresError`. El código runtime observado para las sentencias inválidas y las violaciones probadas fue `ERR_POSTGRES_SERVER_ERROR`. El adaptador debe conservar el error original como `cause` y excluir SQL y parámetros de los mensajes normalizados.
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

Estos límites son defaults operativos del adaptador, no valores del dominio. La URL y las credenciales deben provenir de un canal de configuración protegido, nunca de `.prime-board/` ni de documentación versionada.

## Fuentes primarias

- Bun SQL docs (`oven-sh/bun`, `docs/runtime/sql.mdx`): `Bun.SQL`, opciones de
  pool, `sql.begin`, `sql.reserve` y `sql.close`.
- Validación reproducible y versionada en `scripts/validate-bun-sql.ts`.
