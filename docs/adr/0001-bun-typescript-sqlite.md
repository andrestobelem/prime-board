---
status: aceptada — el rol de SQLite fue acotado por ADR-0004
---

# Bun + TypeScript + SQLite, y no PostgreSQL

prime-board corre local-first en la máquina del usuario, igual que prime-agent, así que la
premisa es **un solo proceso y cero configuración**. Bun trae SQLite integrado (`bun:sqlite`)
y sirve la API y la UI desde el mismo proceso, con persistencia ACID en un archivo único.

Se evaluó PostgreSQL el 2026-08-14 y se **ratificó SQLite puro**: con single-tenant el único
escritor es el proceso Bun, así que la limitación de concurrencia de SQLite no aplica, el
volumen esperado es trivial, y Postgres rompería la premisa de cero configuración.

Se reabre solo si la visión cambia a hosteado/multi-tenant, si hay múltiples instancias del
server, o si aparecen escritores externos directos a la base.
