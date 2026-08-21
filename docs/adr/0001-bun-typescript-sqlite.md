---
status: aceptada — el rol de SQLite fue acotado por ADR-0004
---

# Bun + TypeScript + SQLite, no PostgreSQL

prime-board funciona local-first en la máquina del usuario, igual que prime-agent. La premisa es **un solo proceso y cero configuración**. Bun incluye SQLite (`bun:sqlite`) y sirve la API y la UI desde el mismo proceso. SQLite mantiene la persistencia ACID en un archivo único.

El equipo evaluó PostgreSQL el 2026-08-14 y **ratificó SQLite puro**. En el modo single-tenant, el proceso Bun es el único escritor. Por eso la limitación de concurrencia de SQLite no aplica. El volumen esperado es trivial y PostgreSQL rompería la premisa de cero configuración.

Reabriremos esta decisión si la visión cambia a un servicio alojado o multi-tenant, si ejecutamos varias instancias del server o si aparecen escritores externos directos a la base.
