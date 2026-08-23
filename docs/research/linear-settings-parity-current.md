# Revalidación de Settings parity contra Linear actual

**Fecha de revisión:** 2026-08-22
**Ticket de revisión:** [PRB-520](http://localhost:3333/issue/PRB-520)
**Tickets revisados:** PRB-382 a PRB-395
**Workspace conectado:** [andrestobelem](https://linear.app/andrestobelem)

## Método y límites

- Se consultó el workspace conectado mediante el MCP oficial de Linear.
- Se consultó la documentación oficial actual de Linear y la documentación de Developers.
- No se modificaron issues, proyectos ni configuración en Linear.
- El MCP no expone el plan contratado ni una vista de Settings de la cuenta. Las restricciones por plan quedan marcadas como puntos para verificar en la UI.
- Se conservaron las diferencias intencionales de prime-board: local-first, single-workspace, API-first y Actors de tipo humano/agente.

## Veredicto ejecutivo

Los tickets siguen siendo útiles, pero necesitan precisión en seis puntos:

1. No usar una precedencia general `Account > Team > Workspace`. Linear define el origen según cada preferencia.
2. Separar canales de notificación de webhooks. Linear documenta Desktop, Mobile, Email y Slack como canales; el webhook es una integración.
3. Marcar los automatismos de Triage, la responsabilidad y Triage Intelligence como dependientes de Business/Enterprise.
4. Separar las superficies de Projects, Initiatives, Views, Notifications y Templates para evitar solapamientos.
5. Ajustar Audit y Export a la retención, permisos y formato que Linear documenta.
6. Separar la seguridad disponible para cuentas de las funciones Enterprise: SAML, SCIM e IP restrictions.

## Revisión por ticket

| Ticket                                                 | Veredicto                              | Hallazgo contra Linear actual                                                                                                                                                                                                                                                                                                                                       | Ajuste recomendado                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PRB-382** Preferencias por Workspace, Team y Account | **Ajustar**                            | Linear tiene preferencias personales de cuenta y preferencias de display que pueden ser personales o default del workspace. La documentación no respalda una precedencia única para todos los settings.                                                                                                                                                             | Definir el origen por propiedad. Separar `Account/UserSettings`, defaults de vista y configuración team-scoped. No implementar `Account > Team > Workspace` como regla general. Fuente: [Preferences](https://linear.app/docs/account-preferences), [Display options](https://linear.app/docs/display-options).                                                            |
| **PRB-383** Workflow y automatizaciones                | **Mantener con precisión**             | Los estados son team-scoped. `Duplicate` es reservado, se aplica automáticamente y no se puede renombrar ni personalizar. Auto-close y auto-archive tienen condiciones; el archivado automático no es una acción manual equivalente.                                                                                                                                | Mantener descripción, invariantes, Duplicate, auto-close y auto-archive. Agregar reglas de elegibilidad y aclarar que Duplicate es system-managed. Fuente: [Issue status](https://linear.app/docs/configuring-workflows), [Delete and archive issues](https://linear.app/docs/delete-archive-issues).                                                                      |
| **PRB-384** Triage, routing y prioridad                | **Mantener y marcar plan**             | Linear confirma toggle, responsabilidad, Triage Rules, routing por condiciones y requisito de prioridad. Las reglas, responsabilidad y Triage Intelligence están disponibles en Business/Enterprise. Las reglas se ejecutan en orden y pueden cambiar team, status, assignee, label, project y priority.                                                            | Mantener el alcance. Añadir orden de evaluación, conflictos, origen de issues y el plan gate. Fuente: [Triage](https://linear.app/docs/triage).                                                                                                                                                                                                                            |
| **PRB-385** Templates de Issues y Projects             | **Ampliar**                            | Linear tiene templates de Issue a nivel Workspace/Team, defaults según pertenencia, form templates con campos requeridos y templates de Project con issues, milestones, lead, members, status e initiatives.                                                                                                                                                        | Mantener el ticket. Separar acceptance de issue templates, form templates y project templates. Tratar integraciones como fase posterior. Fuentes: [Issue templates](https://linear.app/docs/issue-templates), [Project templates](https://linear.app/docs/project-templates).                                                                                              |
| **PRB-386** Notificaciones                             | **Ajustar**                            | Los canales documentados son Inbox, Desktop, Mobile, Email y Slack. Webhook no es un canal de notificación personal. Email tiene formato y demora propios.                                                                                                                                                                                                          | Quitar webhook del ticket. Cubrir preferencias por categoría/canal, Inbox, suscripciones y email digest. Coordinar suscripciones de Views/Projects con PRB-390/391. Fuente: [Notifications](https://linear.app/docs/notifications), [Project notifications](https://linear.app/docs/project-notifications).                                                                |
| **PRB-387** Webhooks y OAuth                           | **Mantener y dividir conceptualmente** | Linear firma webhooks con HMAC-SHA256 en `linear-signature`; permite seleccionar `teamId` o `allPublicTeams` y `resourceTypes`. La creación y gestión requiere permisos de admin. OAuth usa scopes y el sistema actual de refresh tokens. La rotación de secretos no aparece como capacidad documentada.                                                            | Mantener webhook seguro y OAuth mínimo como dos entregables. No presentar rotación de secretos como paridad confirmada; dejarla como hardening local. Fuentes: [Webhooks](https://linear.app/developers/webhooks), [API and Webhooks](https://linear.app/docs/api-and-webhooks), [OAuth2](https://linear.app/developers/oauth-2-0-authentication).                         |
| **PRB-388** Timezone, estimates y Cycles               | **Mantener con criterios exactos**     | Linear configura ciclos repetitivos de 1–8 semanas, cooldown, día de inicio, hasta 15 ciclos futuros, rollover y auto-add de issues activos. Estimates tienen escalas configurables, extended scale y zero estimates.                                                                                                                                               | Añadir estos límites y reglas. No modelar cadence como una lista arbitraria de ciclos independientes. Fuentes: [Cycles](https://linear.app/docs/use-cycles), [Estimates](https://linear.app/docs/estimates).                                                                                                                                                               |
| **PRB-389** Labels y groups                            | **Ajustar**                            | Linear confirma descripción, archive, merge, rescope, grupos de un nivel, herencia en sub-teams y hasta 250 labels por grupo. Una label archivada permanece aplicada, pero no se puede usar en nuevos issues. La documentación consultada no confirma una operación separada de restore.                                                                            | Cambiar `archive/restore` por `archive/unarchive` solo si el contrato local lo necesita y documentar la divergencia. Añadir límite de nesting, exclusividad por group y retención en issues. Fuente: [Issue labels](https://linear.app/docs/labels).                                                                                                                       |
| **PRB-390** Views, defaults y suscripciones            | **Ajustar y delimitar**                | Custom Views tienen scope Workspace/Team/Project/Initiative, owner, favoritos y suscripciones. Display options cubre layout, grouping, ordering y columnas, con preferencia personal o default del workspace. Initiative Views son Enterprise.                                                                                                                      | Mantener el ticket para View y ViewPreferences. Quitar la precedencia genérica por Team y separar preferencias de cuenta del ticket PRB-382. Fuente: [Custom Views](https://linear.app/docs/custom-views), [Display options](https://linear.app/docs/display-options).                                                                                                     |
| **PRB-391** Projects e Initiatives                     | **Dividir**                            | Projects tienen lead, teams, members, fechas, milestones, dependencias, templates y notificaciones. Initiatives son objetivos de nivel workspace con status, priority, labels, owner, lead team, target date, resources y updates. Team initiatives son Business/Enterprise; Initiative Views son Enterprise. Templates y notifications se solapan con PRB-385/386. | Separar Project Settings de Initiative Settings. Dejar enlaces explícitos a PRB-385, PRB-386 y PRB-390. Marcar plan gates. Fuentes: [Projects](https://linear.app/docs/projects), [Initiatives](https://linear.app/docs/initiatives), [Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates).                                            |
| **PRB-392** Audit y Export                             | **Ajustar permisos y alcance**         | Audit Log conserva eventos durante 90 días y está disponible en Enterprise; el acceso está limitado a Workspace owners. Exportar workspace issues y members es CSV y depende del rol/plan. El export de issues en vistas tiene otros límites.                                                                                                                       | No exigir evidencia de cada mutación administrativa. Definir tipos de eventos, retención, acceso, export CSV y export API como entregables distintos. Fuente: [Audit log](https://linear.app/docs/audit-log), [Exporting Data](https://linear.app/docs/exporting-data).                                                                                                    |
| **PRB-393** Perfil y preferencias personales           | **Mantener con separación de dominio** | Linear separa Profile de Preferences. Profile cubre avatar, nombre/username, email, connected accounts y leave workspace. Preferences cubre home view, nombres, formato, tema, editor, desktop, auto-assign y otras opciones.                                                                                                                                       | Mantener el ticket. Separar perfil, preferencias y Code & Reviews. En prime-board, no convertir `Actor` en una copia de `User`; conservar Actor humano/agente. Fuentes: [Profile](https://linear.app/docs/profile), [Preferences](https://linear.app/docs/account-preferences), [Code & Reviews](https://linear.app/docs/code-and-reviews).                                |
| **PRB-394** Seguridad avanzada                         | **Dividir por disponibilidad**         | Security & Access incluye sesiones revocables, passkeys, API keys y aplicaciones autorizadas. Las restricciones de login son Business/Enterprise. SAML e IP restrictions son Enterprise. SCIM es Enterprise y cambia la administración de miembros al IdP.                                                                                                          | Separar sesión/credenciales de SSO/SCIM/IP. Mantener SAML/SCIM/IP como evaluación condicionada al despliegue, no como requisito del MVP. Fuentes: [Security & Access](https://linear.app/docs/security-and-access), [Login methods](https://linear.app/docs/login-methods), [SAML](https://linear.app/docs/saml-and-access-control), [SCIM](https://linear.app/docs/scim). |
| **PRB-395** Billing, plan y AI                         | **Mantener fuera del MVP**             | Billing se calcula por usuarios no suspendidos y se aplica al Workspace. AI Credits es un saldo prepagado a nivel Workspace. Loops requiere Business/Enterprise; Coding sessions está disponible desde Basic, Business y Enterprise.                                                                                                                                | Mantener el ticket como evaluación. No agregar billing ni créditos hasta definir despliegue multi-tenant, pagos, seguridad y límites. Fuentes: [Billing and plans](https://linear.app/docs/billing-and-plans), [AI Credits](https://linear.app/docs/ai-credits), [Loops](https://linear.app/docs/loops), [Coding sessions](https://linear.app/docs/coding-sessions).       |

## Solapamientos que deben resolverse

- **PRB-382 y PRB-390:** PRB-382 debe ser dueño de preferencias de cuenta y del modelo de configuración. PRB-390 debe ser dueño de `CustomView` y `ViewPreferences`.
- **PRB-385 y PRB-391:** PRB-385 debe ser dueño de templates. PRB-391 solo debe consumirlos dentro de Project/Initiative Settings.
- **PRB-386 y PRB-390/391:** PRB-386 debe ser dueño de canales y categorías. Las suscripciones de una View o Project deben permanecer en el ticket de la superficie que las crea, con el canal delegado a Notifications.
- **PRB-387 y PRB-386:** webhooks son una integración para agentes, no un canal de preferencias personales.
- **PRB-394 y PRB-379/380:** sesiones, API keys y revocación deben compartir un modelo de credenciales y acceso. No duplicar lifecycle de actores ni de keys.

## Orden recomendado

1. Ajustar acceptance criteria de PRB-382, PRB-384, PRB-386, PRB-387, PRB-391, PRB-392 y PRB-394.
2. Mantener PRB-383, PRB-385, PRB-388, PRB-390, PRB-393 y PRB-395, con las precisiones de esta revisión.
3. Implementar primero la separación de scopes y autorización. Después persistir preferencias, workflow/Triage, templates, notificaciones y ciclos.
4. Postergar Enterprise, billing y AI hasta que exista una decisión de despliegue que los justifique.

## Fuentes primarias consultadas

- [Workspaces](https://linear.app/docs/workspaces)
- [Members and roles](https://linear.app/docs/members-roles)
- [Teams](https://linear.app/docs/teams)
- [Issue status](https://linear.app/docs/configuring-workflows)
- [Triage](https://linear.app/docs/triage)
- [Issue labels](https://linear.app/docs/labels)
- [Issue templates](https://linear.app/docs/issue-templates)
- [Project templates](https://linear.app/docs/project-templates)
- [Cycles](https://linear.app/docs/use-cycles)
- [Estimates](https://linear.app/docs/estimates)
- [Custom Views](https://linear.app/docs/custom-views)
- [Display options](https://linear.app/docs/display-options)
- [Notifications](https://linear.app/docs/notifications)
- [Projects](https://linear.app/docs/projects)
- [Initiatives](https://linear.app/docs/initiatives)
- [Project notifications](https://linear.app/docs/project-notifications)
- [Profile](https://linear.app/docs/profile)
- [Preferences](https://linear.app/docs/account-preferences)
- [Security & Access](https://linear.app/docs/security-and-access)
- [Login methods](https://linear.app/docs/login-methods)
- [SAML](https://linear.app/docs/saml-and-access-control)
- [SCIM](https://linear.app/docs/scim)
- [API and Webhooks](https://linear.app/docs/api-and-webhooks)
- [Webhooks](https://linear.app/developers/webhooks)
- [OAuth2](https://linear.app/developers/oauth-2-0-authentication)
- [Audit log](https://linear.app/docs/audit-log)
- [Exporting Data](https://linear.app/docs/exporting-data)
- [Billing and plans](https://linear.app/docs/billing-and-plans)
- [AI Credits](https://linear.app/docs/ai-credits)
- [Loops](https://linear.app/docs/loops)
- [Coding sessions](https://linear.app/docs/coding-sessions)
