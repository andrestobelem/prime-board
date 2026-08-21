# ADR-0010: Ownership de webhooks

- Estado: aceptado
- Fecha: 2026-08-17

Un **Webhook** es un recurso privado del Actor que lo crea. Ese Actor puede listarlo y borrarlo. Un `admin` del Workspace puede administrar todos los Webhooks. Los demás Actors reciben `UNAUTHORIZED` y no ven el recurso en `webhooks`.

Durante la migración, el sistema atribuye los registros históricos sin owner al primer admin estable. Si no existe uno, los deja disponibles solo para admins. El owner permanece en la base local. El sistema no exporta URLs, secrets ni suscripciones al repositorio, y el rebuild local mantiene esos datos sin revelar credenciales.
