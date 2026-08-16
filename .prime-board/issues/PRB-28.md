---
archivedAt: null
assignee: Carorila
createdAt: 2026-08-15T02:30:26.645Z
creator: claude
cycle: null
id: PRB-28
labels:
  - name: feedback
    team: PRB
milestone: null
parent: null
priority: 0
project: null
sortOrder: 0
state: Done
team: PRB
title: issueCreate debería aceptar labelIds
updatedAt: 2026-08-16T11:47:35.965Z
---

# issueCreate debería aceptar labelIds

Created by claude.

Hoy etiquetar un issue nuevo requiere dos requests: `issueCreate` + `issueUpdate(addLabelIds)`. El import de 26 issues costó 52 llamadas. Agregar `labelIds` al input de creación.

*Encontrado dogfoodeando el import Linear → prime-board.*
