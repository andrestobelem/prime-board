---
status: aceptada; SQLite predeterminado; PostgreSQL opcional en migración incremental
---

# ADR-0001: Bun + TypeScript + SQLite como backend predeterminado

> **Historia:** El título original de esta ADR era "Bun + TypeScript + SQLite, no PostgreSQL". Esa frase describe la exclusión inicial de PostgreSQL. Ya no describe el contrato vigente, pero se conserva para explicar la decisión de origen.

## Decisión original

prime-board funciona local-first en la máquina del usuario, igual que prime-agent. La premisa inicial era **un solo proceso y cero configuración**. Bun incluye SQLite (`bun:sqlite`) y sirve la API y la UI desde el mismo proceso. SQLite mantiene la persistencia ACID en un archivo único.

El equipo evaluó PostgreSQL el 2026-08-14 y **ratificó SQLite puro para el runtime inicial**. En ese momento cada proceso y DB operativos tenían un solo Workspace y el proceso Bun era el único escritor. Por eso la limitación de concurrencia de SQLite no aplicaba. El volumen esperado era trivial y PostgreSQL habría roto la premisa de cero configuración.

## Estado vigente

SQLite sigue siendo el backend predeterminado. La instalación inicial conserva el arranque sin configuración adicional y puede contener varios Workspaces aislados en una misma DB/proceso. El sistema selecciona el Workspace mediante un Workspace Context validado por la credencial, el grant y la Workspace Membership. SQLite conserva la autoridad operativa durante la migración.

PostgreSQL es un backend opcional. Se activa con una configuración explícita y su migración es incremental por dominio. No sustituye a SQLite en un solo cambio. La ruta PostgreSQL actual mantiene un único Workspace por DB/proceso y no ofrece selección multi-Workspace durante la migración. Esta restricción es temporal y no modifica la capacidad multi-Workspace que ya tiene SQLite.

## Transición a ADR-0019

[ADR-0019](0019-event-log-repo-source-postgresql.md) define la arquitectura objetivo para PostgreSQL. En esa topología, el Log append-only del Repository Source será la autoridad del estado compartido y PostgreSQL será una proyección reconstruible. Hasta el cutover, [ADR-0004](0004-repo-como-fuente-de-verdad.md) sigue describiendo el runtime vigente: SQLite es la fuente operativa y `.prime-board` es su réplica controlada.

La migración seguirá el orden `SQLite → Log → PostgreSQL`. ADR-0019 no cambia el backend predeterminado ni convierte PostgreSQL en la autoridad actual. Es el contrato para la transición y para la topología final.

## Revisión de la decisión

El texto original indicaba que la decisión se reabriría si el producto pasaba a un servicio alojado o multi-tenant, si se ejecutaban varias instancias del server o si aparecían escritores externos directos a la base. La incorporación de PostgreSQL opcional reabre esa decisión de forma acotada: SQLite conserva el default y PostgreSQL avanza por migraciones incrementales. Cualquier cambio de default, de la cardinalidad de Workspace en PostgreSQL o de la autoridad de escritura debe actualizar esta ADR y ADR-0019.
