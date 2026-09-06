# Project e Initiative Settings

## Alcance de PRB-391

La API separa los contratos y ACL de `Project` e `Initiative`.

### Project

- `lead`, `members` y `teams`.
- `state`, `startDate` y `targetDate`.
- `milestones` y dependencias entre Projects (`blocks` o `related`).
- La configuración de templates, canales de notificación y Views delega en PRB-385, PRB-386 y PRB-390. Este ticket no crea modelos duplicados.

Los miembros directos pueden leer y administrar la configuración del Project. La escritura de Teams sigue las políticas de cada Team. La asociación de Issues y sus recursos respeta el acceso del Team.

### Initiative

- `state`, `priority`, `owner`, `leadTeam` y `targetDate`.
- `labels`, `resources`, actualizaciones narrativas y Projects asociados.
- El owner conserva la ACL de escritura. La visibilidad usa los Teams y Projects asociados sin convertir una ACL de Project en una ACL de Initiative.

## Export y rebuild

`projects.json` conserva `startDate`, miembros por nombre, milestones y dependencias por nombre natural y tipo. `initiatives.json` conserva prioridad, lead team, labels, resources y updates. El rebuild rechaza referencias desconocidas, tipos inválidos, dependencias propias y referencias fuera del alcance de un export de Team.

Los UUID internos de relaciones se regeneran. No se exportan secretos ni canales de notificación.

## Plan gates

- Initiatives asociadas a Teams requieren Business o Enterprise en Linear. Prime-board conserva la relación en el modelo local-first y no simula billing.
- Initiative Views son Enterprise en Linear. Views y sus preferencias pertenecen a PRB-390.
- Templates pertenecen a PRB-385.
- Categorías y canales de notificación pertenecen a PRB-386. Webhooks son integraciones y no son canales personales.

Las fechas usan `DateTime` por compatibilidad con el contrato actual de prime-board. Linear documenta `TimelessDate` para algunas fechas. Esta diferencia queda explícita y no se normaliza de forma silenciosa.
