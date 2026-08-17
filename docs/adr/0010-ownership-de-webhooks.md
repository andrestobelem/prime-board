# ADR-0010: ownership de webhooks

- Estado: aceptado
- Fecha: 2026-08-17

Un **Webhook** es un recurso privado del actor que lo crea: ese actor puede listarlo y borrarlo, mientras que un `admin` del Workspace puede administrar todos. Los demás actors reciben `UNAUTHORIZED` y no ven el recurso en `webhooks`; los registros históricos sin owner se atribuyen al primer admin estable durante la migración, o quedan admin-only si no existe uno. El owner se conserva solo en la base local: URLs, secrets y suscripciones no se exportan al repositorio, y el rebuild local los mantiene sin revelar credenciales.
