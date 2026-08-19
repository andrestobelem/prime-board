# ADR-0016: Visibilidad y política de acceso de Teams

- Estado: aceptada
- Fecha: 2026-08-19

## Decisión

Cada Team conserva dos dimensiones independientes:

- `visibility` (`public`/`private`) controla descubrimiento y lectura. Un Team público es legible por actores activos del Workspace; uno privado sólo es legible por sus miembros y admins.
- `accessPolicy` (`workspace_members`/`team_members`) controla escrituras y asignaciones. La primera permite operar sobre Teams públicos a miembros activos del Workspace; la segunda exige membership activa. Un Team privado siempre usa `team_members`.

Los roles de Workspace, memberships, ownership y límites de API keys siguen siendo capas independientes: una key nunca agrega permisos. Las memberships de actores suspendidos o retirados no cuentan como activas.

Los proyectos multi-Team requieren acceso a todos sus Teams. Webhooks se asocian opcionalmente a un Team y, aun sin asociación, sólo se entregan si el owner puede leer todos los Teams del evento. Las iniciativas, reviews y vistas guardadas con scope Team conservan además sus controles de membership existentes. No se exportan secretos.

## Compatibilidad

La migración usa `public` y `team_members` como defaults para conservar el comportamiento previo de lectura pública y escritura restringida a miembros. Los exports legacy sin estos campos usan esos mismos defaults; los exports nuevos preservan ambos valores.
