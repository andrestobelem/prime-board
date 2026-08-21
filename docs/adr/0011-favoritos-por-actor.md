# ADR-0011: Favoritos privados por Actor

- Estado: aceptado
- Fecha: 2026-08-17

## Decisión

Los favoritos son relaciones privadas del Actor autenticado. Cada fila referencia exactamente un Project o una Saved View mediante una FK explícita y conserva un `position` entero que empieza en cero. `favoriteCreate` es idempotente por Actor y recurso. `favoriteDelete` es idempotente para el Actor propietario. `favoriteReorder` recibe el índice destino y renumera la lista completa para evitar empates.

`Query.favorites` no acepta `actorId`: siempre devuelve solo los favoritos del viewer. El sistema no permite agregar Saved Views personales de otro Actor ni recursos inexistentes. Conserva Projects y Saved Views archivados en la relación para que desarchivar restaure el favorito, pero los excluye del listado. `ON DELETE CASCADE` protege el borrado físico.

## Repositorio y rebuild

`meta/favorites.json` usa nombres naturales (Actor, Project y la clave compuesta de Saved View: Scope, Team, owner y nombre). Nunca guarda UUIDs ni credenciales. Un export parcial omite favoritos de Saved Views fuera del Team exportado. El rebuild resuelve esas claves después de crear Projects y Saved Views, valida duplicados y reconstruye el orden.
