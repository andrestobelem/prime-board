# ADR-0020: retiro seguro de Documents

- Estado: aceptado
- Fecha: 2026-09-05
- Alcance: SQLite, PostgreSQL y Repository Replica

## Decisión

Documents deja de ser una entidad operativa. Las migraciones históricas `0027` (SQLite) y
`0005` (PostgreSQL) permanecen en sus registros. Las migraciones nuevas `0030` y `0011`
retiran las tablas y sus índices después de verificar un archivo externo.

El archivo lo crea el operador con `archive:documents` en un destino fuera del repositorio:

```bash
bun run --cwd apps/server archive:documents --out /ruta/externa/prime-board-documents.archive.json
bun run --cwd apps/server archive:documents --from-repo /ruta/proyecto --out /ruta/externa/prime-board-documents.archive.json
```

El bundle JSON contiene fuentes, cantidad y SHA-256. El archivo usa permisos `0600` y debe
estar fuera del repositorio (incluido `.prime-board`). La migración no crea el archivo. Si Documents tiene filas y el
manifest no existe o no coincide, el proceso falla antes de `DROP TABLE`. Las instalaciones
nuevas ejecutan las migraciones históricas y retiran la tabla vacía al terminar.

## Réplica y rebuild

Un export nuevo no genera `meta/documents.json`. Si encuentra una captura histórica, export y
rebuild fallan sin un destino externo explícito. Con ese destino, archivan y verifican la captura
y luego eliminan solo `documents.json`; nunca convierten el contenido en una descripción de
Issue. El preflight marca una captura pendiente como fallo. El archivo externo no se versiona.

La importación de artefactos externos de Linear conserva URL y título como enlaces en la sección
`Linear artifacts`, según la política de `docs/specs/migracion-linear.md`. Esa conversión no
reactiva Documents locales ni copia contenido a descripciones de Issues.

## Consecuencias

- Un upgrade de una base con Documents requiere una operación explícita de archivo.
- La lista histórica de migraciones y sus checksums no cambia.
- PostgreSQL valida el manifest desde el runner antes de ejecutar el SQL; el SQL solo elimina
  tablas auxiliares, índices, triggers y funciones.
- El contenido archivado queda fuera del control de acceso de la aplicación. El operador debe
  proteger y conservar el destino según su política de backup.
