# ADR-0020: Workflows reservados y automatizaciones de Team

- Estado: aceptado para PRB-383
- Fecha: 2026-09-07

## Decisión

Cada Team conserva sus estados de workflow y sus descripciones. El sistema agrega un estado `Duplicate` con estas propiedades: `type = canceled`, `is_reserved = true` y descripción administrada por el sistema. `Duplicate` no puede ser creado, renombrado, editado, reordenado, usado como estado default ni eliminado por la API.

Una relación `duplicate_of` marca el Issue de origen con el estado reservado `Duplicate`. El Issue canónico conserva su estado. La operación registra el cambio de estado y los eventos de relación dentro de la misma transacción. Quitar la relación no revierte el estado.

El Team puede guardar `autoClosePeriod`, `autoArchivePeriod`, `autoCloseStateId`, `autoCloseParentIssues` y `autoCloseChildIssues`. Un período nulo deshabilita la automatización. La API acepta `0` como otra forma de deshabilitarla y lo guarda como `NULL`. La evaluación de elegibilidad no ejecuta cambios ni inicia un scheduler. El archive manual (`issueArchive`) sigue siendo una operación separada y disponible; configurar auto-archive no la reemplaza.

Auto-close requiere un Issue abierto e inactivo. También requiere que no exista un ciclo activo, que los proyectos sean finales y que no haya sub-Issues abiertos. Las flags de jerarquía pueden excluir padres o hijos. Auto-archive requiere un Issue cerrado e inactivo. La función de evaluación solo devuelve una decisión para un worker posterior.

## Secuencia de migraciones

La cadena canónica deja los IDs de Documents retirement de PRB-388/PRB-390 antes de este cambio. PRB-383 usa SQLite `0033_workflow_state_description_reserved` y `0034_team_workflow_automation`. En PostgreSQL usa `0014_workflow_state_description_reserved` y `0015_team_workflow_automation`. PRB-384 y PRB-391 pueden requerir una reconciliación de IDs si agregan migraciones en paralelo.

## Exportación y compatibilidad

`teams.json` conserva la configuración de automatizaciones. Cada estado conserva `description` e `isReserved`. El importador de exports viejos crea el estado reservado `Duplicate` si falta y no permite que sea el estado default. Si un export viejo tiene una relación `duplicateOf`, el importador aplica también el estado reservado al Issue de origen.

Esta decisión es específica de PRB-383. No sustituye las políticas posteriores de PRB-540/PRB-600, que modelan el duplicado con otra combinación de relación y estado `Canceled`. Las dos políticas no se mezclan en este cambio.

## Consecuencias

- El estado reservado permanece visible para lectura, pero no es una superficie de personalización.
- La relación y el estado de duplicado siguen siendo datos distintos. La relación no se usa como transición libre.
- Un worker futuro puede usar `evaluateAutoClose`, `evaluateAutoArchive` y `listAutomationCandidates` sin duplicar las reglas de elegibilidad.
- Las migraciones backfillean el estado reservado en Teams existentes.
