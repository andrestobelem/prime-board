# ADR-0016: Visibilidad y política de acceso de Teams

- Estado: aceptada
- Fecha: 2026-08-19

## Decisión

Cada Team conserva dos dimensiones independientes:

- `visibility` (`public`/`private`) controla el descubrimiento y la lectura. Los Actors activos del Workspace pueden leer un Team público. Solo sus members y admins pueden leer un Team privado.
- `accessPolicy` (`workspace_members`/`team_members`) controla escrituras y asignaciones. La primera permite operar sobre Teams públicos a los Actors activos del Workspace; la segunda exige Membership activa. Un Team privado siempre usa `team_members`.

Workspace Roles, Memberships, ownership y límites de API keys siguen siendo capas independientes. Una key nunca agrega permisos. Las Memberships de Actors suspendidos o retirados no cuentan como activas.

Los Projects multi-Team requieren acceso a todos sus Teams. Un Webhook puede asociarse a un Team. Incluso sin asociación, el sistema lo entrega solo si el owner puede leer todos los Teams del evento. Initiatives, Reviews y Saved Views con Team Scope conservan sus controles de Membership. El sistema no exporta secretos.

## Compatibilidad

La migración usa `public` y `team_members` como defaults. Así conserva la lectura pública y la escritura restringida a members. Los exports legacy sin estos campos usan los mismos defaults. Los exports nuevos preservan ambos valores.
