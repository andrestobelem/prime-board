# Harness de integración PostgreSQL

- **Ticket:** PRB-429
- **Implementación:** `apps/server/src/db/postgres/test-harness.ts`

## Aislamiento

`createPostgresHarness({ url })` reserva una conexión del pool, genera un schema
con un nombre seguro y único, configura `search_path` y aplica el migrator y el
baseline en ese schema. Cada ejecución recibe tablas, `schema_migrations` y
vectores de búsqueda propios; dos harnesses paralelos no comparten datos. La
conexión reservada se libera antes de borrar el schema y cerrar el pool.

El harness no cambia el servidor de producción ni guarda credenciales. El
baseline y el migrator siguen siendo los mismos artefactos que se ejecutarían en
una instancia de integración.

## Smoke reproducible

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-harness.ts
```

El script crea dos harnesses en paralelo, inserta un Workspace diferente en cada
uno y verifica que cada schema solo vea el propio dato. Después ejecuta una
consulta GraphQL Yoga (`workspace` y `workspaceCount`) cuya resolución lee el
PostgreSQL del primer harness. Esto verifica la frontera GraphQL→Bun.SQL→schema
aislado sin levantar un servidor persistente ni exponer secretos.

La ejecución validada devolvió:

```json
{ "passed": true, "report": { "isolation": true, "graphql": true } }
```

El contenedor, red, volumen, secreto y máquina Podman de la ejecución fueron
eliminados. Para la futura migración del servidor, los resolvers de producción
podrán reutilizar el mismo harness sustituyendo el resolver smoke por el
`createApp` adaptado a `Persistence`; hasta entonces el smoke es explícitamente
un contrato de integración del driver, no una afirmación de que los dominios
SQLite síncronos ya fueron migrados.
