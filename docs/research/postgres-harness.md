# Harness de integración PostgreSQL

- **Ticket:** PRB-429
- **Implementación:** `apps/server/src/db/postgres/test-harness.ts`

## Aislamiento

`createPostgresHarness({ url })` reserva una conexión del pool, genera un schema con un nombre seguro y único, configura `search_path` y aplica el migrator y el baseline en ese schema. Cada ejecución recibe sus propias tablas, `schema_migrations` y vectores de búsqueda. Dos harnesses paralelos no comparten datos. El harness libera la conexión antes de borrar el schema y cerrar el pool.

El harness no cambia el server de producción ni guarda credenciales. Usa los mismos artefactos de baseline y migrator que una instancia de integración.

## Smoke reproducible

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-harness.ts
```

El script crea dos harnesses en paralelo, inserta un Workspace distinto en cada uno y verifica que cada schema solo vea su propio dato. Después ejecuta una query GraphQL Yoga (`workspace` y `workspaceCount`) cuya resolución lee el PostgreSQL del primer harness. Así verifica la frontera GraphQL→Bun.SQL→schema aislado sin levantar un server persistente ni exponer secretos.

La ejecución validada devolvió:

```json
{ "passed": true, "report": { "isolation": true, "graphql": true } }
```

El equipo eliminó el contenedor, la red, el volumen, el secreto y la máquina Podman de la ejecución. Durante la futura migración del server, los resolvers de producción podrán reutilizar el harness y sustituir el resolver smoke por `createApp` adaptado a `Persistence`. Hasta entonces, el smoke es un contrato de integración del driver, no una afirmación de que los dominios SQLite síncronos ya migraron.
