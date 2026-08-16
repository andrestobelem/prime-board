---
archivedAt: null
assignee: Lucía
createdAt: 2026-08-15T02:30:26.634Z
creator: claude
cycle: null
id: PRB-27
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
title: "Importer: preservar fechas y autor originales"
updatedAt: 2026-08-16T11:47:35.746Z
---

# Importer: preservar fechas y autor originales

Created by claude.

Al importar los 26 tickets desde Linear, `createdAt`/`updatedAt` quedaron en el momento del import y el creador es quien importa (claude). Para migraciones reales hace falta que `issueCreate` acepte overrides opcionales (`createdAt`, `completedAt`, `creatorId`) — quizá solo para actores admin.

*Encontrado dogfoodeando el import Linear → prime-board.*
