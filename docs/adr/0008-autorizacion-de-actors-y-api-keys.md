# ADR-0008: Autorización del roster y las API keys

- Estado: aceptado
- Fecha: 2026-08-16

## Contexto

Todos los actors se autentican con su propia API key, pero autenticar una operación no
implica que el actor pueda administrar a otros actors o sus credenciales. La sección
Members necesita una política que pueda aplicar tanto la API como la UI.

## Decisión

Cada actor tiene un `workspaceRole`: `admin` o `member`.

- `admin` puede crear actors, editar cualquier actor y crear o revocar cualquier API key.
- `member` puede editar su propio actor y crear o revocar únicamente sus propias API keys.
- `actorCreate` requiere `admin`.
- `actors` conserva el roster consultable para asignaciones; los metadatos de API keys solo
  se listan para el propio actor o para un admin.
- El rol no se infiere del nombre ni de si el actor es humano o agente. La migración conserva
  el actor bootstrap `admin` como admin y los nuevos actors se crean como members.

Las operaciones no autorizadas devuelven `UNAUTHORIZED`. Las operaciones sobre recursos
inexistentes mantienen `NOT_FOUND`.

## Consecuencias

- El rol debe viajar en `meta/actors.json` para que export/import no degrade la política.
- La UI Members oculta acciones que el viewer no puede ejecutar; la API sigue siendo la
  autoridad final.
- No existe todavía una mutation para cambiar roles: esa capacidad queda fuera de este
  alcance para evitar que un member se eleve a admin.
