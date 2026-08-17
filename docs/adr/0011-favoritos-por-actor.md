# ADR-0011: favoritos privados por actor

- Estado: aceptado
- Fecha: 2026-08-17

## Decisión

Los favoritos son relaciones privadas del actor autenticado. Cada fila referencia exactamente
un proyecto o una vista guardada mediante una FK explícita y conserva un `position` entero
ordenado desde cero. `favoriteCreate` es idempotente por actor y recurso; `favoriteDelete`
es idempotente para el propio actor; `favoriteReorder` recibe el índice destino y renumera
la lista completa para evitar empates.

`Query.favorites` no acepta `actorId`: siempre devuelve únicamente los favoritos del viewer.
Las vistas personales de otro actor y los recursos inexistentes no pueden agregarse. Los
proyectos y vistas archivados se conservan en la relación para que desarchivar restaure el
favorito, pero se excluyen del listado; el borrado físico queda protegido por `ON DELETE
CASCADE`.

## Repositorio y rebuild

`meta/favorites.json` usa nombres naturales (actor, proyecto y la clave compuesta de vista:
scope, team, owner y nombre), nunca UUIDs ni credenciales. El export parcial omite favoritos
de vistas fuera del team exportado. El rebuild resuelve esas claves después de crear
proyectos y vistas, valida duplicados y reconstruye el orden.
