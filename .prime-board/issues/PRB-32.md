---
archivedAt: null
assignee: Lucía
createdAt: 2026-08-15T03:39:42.010Z
creator: claude
id: PRB-32
labels: []
milestone: null
parent: null
priority: 0
project: null
state: Done
team: PRB
title: "issueCreate: aceptar number para conservar identificadores en imports"
updatedAt: 2026-08-16T11:47:35.808Z
---

# issueCreate: aceptar number para conservar identificadores en imports

Al importar desde Linear, los tickets se renumeraron (AT-126 → AT-1) porque `issueCreate` siempre asigna `next_issue_number`. Permitir un `number` opcional en `IssueCreateInput`:

- Valida entero > 0 y único en el team (`VALIDATION_FAILED` si está tomado).
- Ajusta `next_issue_number = max(actual, number + 1)` para no colisionar después.
- Exponer en CLI (`pb issue create --number`) y MCP (`save_issue.number`).
- Aplicar retroactivamente a los 26 importados para que recuperen AT-126..AT-152.

*Pedido por Andrés al revisar el import.*
