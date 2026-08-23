# Reviews en PostgreSQL

- **Ticket:** PRB-441
- **Implementación:** `apps/server/src/domain/postgres-reviews.ts`
- **Validación:** `scripts/validate-postgres-reviews.ts`

## Alcance

Con `PRIME_BOARD_PERSISTENCE=postgres`, las operaciones GraphQL `reviews`, `review`,
`reviewCreate`, `reviewUpdate` y `reviewDelete` usan `Persistence` y no consultan el SQLite
seam. El adaptador conserva la cola visible al requester o reviewer, el filtro `openOnly`,
los filtros por Team, proyecto, reviewer y antigüedad, el límite `first` y el orden estable por
`created_at` e `id` descendentes.

Las mutaciones validan el acceso de escritura al Team del issue y el acceso del reviewer. Una
API key limitada por Team no puede crear, leer, actualizar ni borrar una Review de otro Team.
Los participantes de una Review mantienen la misma regla de autorización: requester, reviewer o
Workspace Admin pueden actualizarla o borrarla.

## Integridad

El baseline PostgreSQL conserva las tres claves foráneas de `reviews` hacia `issues` y `actors`.
La validación crea y elimina Reviews en un schema aislado y comprueba el contrato GraphQL, la
cola, el filtro de estado, la autorización, el borrado y las tres restricciones.

Reviews no agregan un tipo nuevo al historial de actividad. Este comportamiento conserva el
contrato SQLite actual. La exportación e importación de Reviews sigue usando el formato de la
réplica (`meta/reviews.json`); sus pruebas existentes continúan cubriendo el round-trip.
