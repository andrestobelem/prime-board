# ADR-0008: Autorización del roster y las API keys

- Estado: aceptado
- Fecha: 2026-08-16

## Contexto

Cada Actor se autentica con su propia API key. Autenticar una operación no concede permiso para administrar otros Actors ni sus credenciales. La sección Members necesita una política que apliquen tanto la API como la UI.

## Decisión

Cada Actor tiene un `workspaceRole`: `admin` o `member`.

- `admin` puede crear Actors, editar cualquier Actor y crear o revocar cualquier API key.
- `member` puede editar su propio Actor y crear o revocar solo sus propias API keys.
- `actorCreate` requiere `admin`.
- `actors` conserva el roster para las asignaciones. La API solo lista metadata de API keys para el Actor propietario o para un admin.
- El sistema no infiere el rol del nombre ni del tipo humano o agente. La migración conserva como admin al Actor bootstrap `admin` y crea los nuevos Actors como members.

Las operaciones no autorizadas devuelven `UNAUTHORIZED`. Las operaciones sobre recursos inexistentes mantienen `NOT_FOUND`.

## Consecuencias

- El rol debe viajar en `meta/actors.json` para que export/import conserve la política.
- La UI Members oculta acciones que el viewer no puede ejecutar. La API sigue siendo la autoridad final.
- Todavía no existe una mutation para cambiar roles. Esta capacidad queda fuera de alcance para impedir que un member se eleve a admin.
