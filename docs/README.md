# Documentación

Este índice organiza la documentación por audiencia y por tipo. El contrato operativo vigente
está en la guía de agentes y en los documentos de `docs/agents/`. Los documentos que describen
el MVP o decisiones anteriores indican su carácter histórico.

## Por audiencia

- **Quiero poner el proyecto en marcha:** [README](../README.md) y [guía de operación](guia-agentes.md).
- **Soy un agente o integro un cliente:** [guía de operación para agentes](guia-agentes.md),
  [issue tracker](agents/issue-tracker.md) y [contrato GraphQL de Workspace](agents/graphql-workspace.md).
- **Mantengo las skills y la documentación de agentes:** [documentación del dominio](agents/domain.md),
  [estados de triage](agents/triage-labels.md) y [convenciones del repositorio](../AGENTS.md).
- **Necesito entender el alcance o una decisión:** [alcance histórico del MVP](alcance-mvp.md),
  [especificación histórica del MVP](specs/mvp.md) y [ADRs](adr/).
- **Investigo una diferencia o una migración:** [auditorías](audits/) y [research](research/).

## Por tipo

### Entradas y operación

- [README](../README.md): instalación, inicio rápido, clientes, exportación y reconstrucción.
- [Guía de operación para agentes](guia-agentes.md): server, API GraphQL, CLI `pb`, MCP,
  webhooks y réplica.
- [Issue tracker](agents/issue-tracker.md): cómo crear, reclamar, verificar y cerrar Issues.
- [Documentación del dominio](agents/domain.md): orden de lectura del contexto del dominio.
- [Estados de triage](agents/triage-labels.md): relación entre roles de triage y Workflow States.
- [Procedimiento de corte Linear → prime-board](specs/cutover-linear.md): procedimiento histórico de corte.

### Alcance y especificaciones

- [Alcance del MVP](alcance-mvp.md): alcance y decisiones estructurales del MVP histórico.
- [Especificación técnica del MVP](specs/mvp.md): especificación histórica; no es el contrato actual.
- [Contrato de migración Linear → prime-board](specs/migracion-linear.md): entradas y salidas de la migración.
- [Relevamiento de Linear](relevamiento-linear.md): inventario usado como referencia histórica.
- [Design system de la UI web](design-system.md): tokens, temas, tipografía, componentes,
  iconografía y patrones de `apps/web`; incluye el [canvas visual](design-system/prime-board-design-system.html).

### Contratos para agentes

- [Contrato GraphQL de Workspace](agents/graphql-workspace.md): listado, selección y autorización de Workspaces.
- [Issue tracker](agents/issue-tracker.md): operación de Issues en el Team `PRB`.
- [Guía de operación](guia-agentes.md): comandos y ejemplos ejecutables.

### Decisiones de arquitectura

- [ADRs](adr/): decisiones con impacto en el diseño y la operación.
- [Multi-Workspace compartido](adr/0017-multi-workspace-compartido.md): decisión vigente para Workspaces aislados en una DB y proceso.
- [Repositorio como fuente de verdad](adr/0004-repo-como-fuente-de-verdad.md): estado actual de la DB y de `.prime-board/`.

### Auditorías

- [Diferencias frente a Linear actual](audits/linear-actual-diferencias.md): comparación canónica; no promete compatibilidad completa.
- [Modelo de datos frente a Linear](audits/linear-modelo-datos.md): entidades y relaciones.
- [API GraphQL frente a Linear](audits/linear-paridad-graphql.md): diferencias del contrato GraphQL.
- [UI y usabilidad frente a Linear](audits/linear-paridad-visual-usabilidad.md): revisión visual y de interacción.

### Investigaciones

- [Tickets en el repositorio](investigacion-tickets-en-repo.md): investigación histórica sobre event sourcing y exportación; el contrato vigente usa SQLite como fuente operativa y `.prime-board/` como réplica.
- [Extensión `question` para prime-agent](extensiones-prime-agent.md): uso de la extensión para preguntas interactivas.
- [Prime-board como extensión de prime-agent](research/prime-board-como-extension-prime-agent.md): opciones de empaquetado.
- [SQLite y PostgreSQL con Podman](research/sqlite-postgresql-podman.md): migración investigada.
- [Baseline de PostgreSQL](research/postgres-baseline.md): decisiones del baseline.
- [Harness de PostgreSQL](research/postgres-harness.md): entorno de integración.
- [Migraciones de PostgreSQL](research/postgres-migrations.md): plan y estado de migraciones.
- [Runbook PostgreSQL con Podman](research/postgres-podman-runbook.md): ejecución operativa local.
- [PostgreSQL y credenciales](research/postgres-credentials.md): manejo operativo de credenciales.
- [PostgreSQL y Workspaces/Actors](research/postgres-workspace-actors.md): modelo de identidad.
- [PostgreSQL y Teams](research/postgres-teams.md): modelo de Teams.
- [Issues de PostgreSQL](research/postgres-issues.md): seguimiento de la migración.
- [Validación Bun SQL/PostgreSQL](research/bun-sql-postgresql-validation.md): resultados de validación.
- [Settings de Linear](research/linear-settings-parity.md): snapshot histórico.
- [Settings actual](research/linear-settings-parity-current.md): snapshot de comparación.
- [Catppuccin](research/catppuccin.md): paleta, mapeo semántico y licencia.

### Referencia interna y legal

- [Operar agentes en Ghostty](internal/operar-agentes-en-ghostty.md): runbook interno.
- [Export de Linear](migrations/linear-export-2026-08-16.json): datos históricos de migración.
- [Aviso MIT de Catppuccin](licenses/catppuccin-MIT.txt): licencia del tema incluido.
