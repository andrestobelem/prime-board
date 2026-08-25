---
status: aceptado
---

# ADR-0020: Billing, planes y uso de AI fuera del modelo local

- **Contexto:** PRB-395

prime-board mantiene un modelo local-first y single-tenant. Linear ofrece billing, planes, seats y uso de AI como capacidades de un servicio hospedado, pero el despliegue local actual no tiene un proveedor de identidad hospedado, una cuenta comercial ni un sistema de medición confiable.

## Decisión

No se implementan billing, planes, seats, créditos de AI, límites comerciales ni affordances equivalentes en el contrato GraphQL, CLI, MCP o UI de prime-board. Tampoco se agregan tablas, migraciones, eventos de réplica ni campos de dominio para esas capacidades.

La documentación debe presentar esta ausencia como una divergencia intencional y no como una capacidad pendiente del MVP. Si el producto adopta un servicio multi-tenant hospedado, se crearán tickets separados para el modelo de Workspace comercial, la autorización de administración, la medición, la facturación, los límites y la recuperación ante errores. Ese cambio no reutilizará datos locales como fuente comercial sin una decisión explícita de migración.

## Consecuencias

- No hay datos de billing o AI que exportar, reconstruir o proteger en `.prime-board/`.
- Las comparaciones con Linear deben conservar la etiqueta **fuera de alcance** para estas superficies.
- Un cambio futuro de topología debe revisar esta decisión antes de publicar campos o controles de plan.
