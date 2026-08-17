# Auditoría de paridad visual y usabilidad con Linear

> Ticket: [PRB-278](http://localhost:3333/issue/PRB-278)
> Fecha: 2026-08-17
> Alcance: UI web actual de `apps/web`, contrato GraphQL vigente y documentación oficial de Linear.

## Veredicto

prime-board ya transmite una experiencia **Linear-like reconocible**: shell oscuro y denso, sidebar por workspace/team, lista y board, detalle de issue con edición inline, filtros, favoritos, creación rápida y command palette. Además, para el caso de uso de agentes ofrece algo que Linear no prioriza como interfaz principal: CLI `pb`, MCP, actores `AGENT`, API keys por actor y webhooks.

La diferencia principal no es la paleta: es la **profundidad de las interacciones**. Linear permite que casi cualquier acción sobre una issue se ejecute igual desde lista, board, detalle, teclado, command menu o menú contextual. En prime-board esos caminos existen solo para una parte de las acciones. El siguiente salto no es copiar más pantallas, sino cerrar esos caminos y hacer que los cambios sean confiables y accesibles.

## Qué ya está bien

| Área                    | Estado         | Evidencia en prime-board                                                                                                                                                                     |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell visual            | ✅             | Tema dark-first, superficies y bordes sutiles, sidebar de 220 px, iconos monocromos, densidad alta y estados hover/active en `apps/web/src/styles.css`.                                      |
| Jerarquía de navegación | ✅             | Workspace, `Your teams`, Home/Issues/Triage, Projects, Views, Cycles y Favorites en `components/Sidebar.tsx`; `navigation.ts` separa vistas workspace/team y deduplica proyectos multi-team. |
| Issues                  | ✅             | Lista agrupada, prioridades, estados semánticos, labels, assignee, selección visible, board con drag & drop y aviso explícito del límite de 250 resultados.                                  |
| Detalle                 | ✅             | Título y descripción inline en Markdown, propiedades laterales, sub-issues, relaciones, comentarios, actividad y navegación anterior/siguiente en `views/IssueView.tsx`.                     |
| Acceso rápido           | ✅ parcial     | `C` crea y `⌘K` abre la palette; `J/K`, flechas y `Enter` permiten recorrer/abrir issues.                                                                                                    |
| Agent-first             | ✅ diferencial | La API, CLI y MCP cubren el flujo operativo; actores humanos y agentes son de primera clase; los webhooks reemplazan buena parte del polling.                                                |
| Responsive básico       | ✅ parcial     | Sidebar móvil con drawer/backdrop y layouts adaptados para toolbar, board y detalle en `styles.css`.                                                                                         |

## Matriz de paridad

### 1. Shell y navegación

**Prime-board está suficientemente cerca** de la referencia visual en la estructura que importa: workspace arriba, recursos globales, favoritos y equipos debajo. No conviene implementar `Switch workspace`: el dominio está decidido como single-workspace (ADR-0003 y PRB-267).

Diferencias aceptables para nuestro producto:

- Linear tiene más entradas de producto (Agent, Pulse, Customers, More, Connect Cursor/Codex) y personalización/reordenamiento del sidebar. No son todas necesarias para operar un board local para agentes.
- Linear permite ocultar/reordenar entradas y agrupar recursos poco frecuentes bajo `More`; prime-board mantiene una taxonomía fija. Es una mejora de comodidad, no una deuda del modelo.
- Prime-board muestra `Teams`, `Inbox` e `Initiatives` como superficies explícitas; Linear puede agrupar algunas detrás de `More` según la configuración.
- No se busca copiar branding, avatares fotográficos ni cada icono de navegación; sí se busca conservar jerarquía, densidad, contraste y feedback.

### 2. Lista, board y selección — diferencia importante

Linear documenta que una issue resaltada puede operarse con teclado, command menu o menú contextual, y que lista y board comparten casi toda la superficie de acciones. Prime-board tiene selección con checkbox y un único bulk action visible: cambiar estado (`IssueFilterToolbar.tsx`). La palette hoy navega, crea issues, abre Settings y cambia tema, pero no actualiza la issue seleccionada (`components/Palette.tsx`).

Faltan para que el flujo se sienta completo:

- `X`, `Shift+X` y `Cmd/Ctrl+A` para seleccionar; acciones de selección para assignee, priority, labels, project, cycle, archive y relaciones.
- `?` para ayuda de atajos y `/`/`Cmd/Ctrl-F` para búsqueda contextual; `Cmd/Ctrl-K` debe ser contextual a la issue o selección, no solo un lanzador de navegación.
- Menú contextual/overflow consistente en filas y cards.
- Crear una issue desde el encabezado de una columna del board.
- Reordenamiento manual y movimiento de issues con teclado.
- Ocultar columnas, mostrar grupos vacíos, swimlanes, peek/preview y display properties.
- Paridad de acciones entre lista y board.

La parte que sí conviene conservar es el modelo actual de columnas por estado semántico: permite que un board multi-team no dependa de nombres idénticos de estados.

### 3. Filtros, búsqueda y vistas guardadas — diferencia importante

El API soporta filtros por team, state/state type, assignee, creator, project, milestone, cycle, parent, priority, labels, búsqueda FTS, `unblocked` y composición `and/or`. La UI de team solo expone búsqueda, state, assignee, priority y una label (`issue-filter.ts` y `IssueFilterToolbar.tsx`).

Linear trata una view como otra lectura dinámica de los mismos issues: sus filtros pueden combinarse, compartirse por URL y guardarse junto con layout, grouping, ordering y propiedades visibles. También ofrece `O-V`/`Shift-V` para abrir views/display options. Hay una brecha de producto en Saved Views:

- crear una vista desde el sidebar solo pide nombre y fuerza `scope: TEAM`;
- la vista creada desde el botón de `Workspace > Views` puede no aparecer allí porque el callback elige el team actual;
- una vista guardada puede renombrarse o borrarse, pero no se edita su filtro, orden, agrupación, columnas o scope desde la UI;
- el backend permite `and/or`, project, cycle, milestone, parent y `unblocked`, pero la toolbar no los ofrece.

Linear concentra filtros, layout, grouping, ordering y display properties en `Display options`, y permite guardar esas opciones como vistas. Prime-board tiene los datos y mutations necesarios, pero no ofrece todavía ese editor único.

### 4. Detalle de issue y confiabilidad

La composición visual está bien encaminada, pero hay acciones que no tienen el mismo acabado:

- El menú de issue expone copiar link/identifier y volver a la lista, pero no archivar la issue aunque existe `issueArchive` en GraphQL.
- Linear también ofrece suscripción, menciones y delegación; prime-board tiene asignación y actores agentes, pero todavía no tiene suscriptores/menciones como superficie explícita. Para agentes, Activity + webhooks cubren parte del caso y la suscripción visual puede esperar.
- Cambios de título, descripción, labels, relaciones y comentarios no muestran siempre estado de guardado ni error inline; algunas promises se disparan sin `catch`, y el comentario se limpia antes de confirmar éxito.
- Los dialogs y popovers manejan Escape en algunos casos, pero no hay foco atrapado/retornado ni `aria-modal` en `EntityModal`; las filas y cards principales son `div` clickeables y no elementos enfocables.
- El drag & drop del board no tiene una alternativa de teclado equivalente.

Para un producto usado por agentes y humanos, esta es una prioridad: una operación perdida o silenciosamente fallida cuesta más que una diferencia visual.

### 5. Proyectos y planificación

La API y la UI ya superan el MVP histórico: hay proyectos multi-team, milestones, status updates, iniciativas, cycles, reviews, inbox y favoritos. La pantalla de proyecto actual muestra header, updates, milestones e issues, y permite archivar/postear update.

Frente a Linear todavía faltan, pero son **deseables**, no bloqueantes del núcleo:

- Overview/Issues como tabs claramente separados.
- Editar desde la UI nombre, descripción, lead, estado, fecha objetivo y teams del proyecto.
- Crear, editar, borrar y reordenar milestones desde el overview.
- Project details sidebar y vistas guardadas adjuntas al proyecto.
- Workspace Projects con layouts list/board/timeline, filtros y ordenamiento.

No recomendamos incorporar Timeline/Roadmap ni documentos colaborativos solo para cerrar la comparación visual; están fuera del foco agent-first.

### 6. Inbox, reviews y triage

Estas superficies existen y tienen estados loading/error/empty, acciones básicas y filtros en reviews. Linear agrega quick search, display options, unread/read, snooze/reminders y navegación por teclado en Inbox. Para prime-board:

- **Mantener:** Inbox como conveniencia humana y Reviews/Triage porque ya tienen valor operativo.
- **Priorizar después:** unread count, búsqueda/filtros rápidos, acciones de teclado y detalle contextual. Linear usa `G-I`, `J/K`, `U`, `H` y `Cmd/Ctrl-F` en esta superficie; no hace falta copiar todos desde el primer corte.
- **No hacer ahora:** reminders/snooze complejos si el webhook y el CLI cubren el flujo de agentes.

### 7. Estados de datos, volumen y descubribilidad

Hay tres problemas que no aparecen en una captura estática pero cambian mucho la sensación de producto:

- El shell se monta con sidebar vacío durante `SHELL_QUERY`; ante un error se muestra un banner sin `Retry`.
- Las listas fijan `first: 250`. El aviso dice que hay que estrechar filtros, pero Board y Project no comparten el toolbar y no existe load-more/cursor UI.
- Los estados vacíos no distinguen “no hay datos” de “los filtros no coinciden”: la lista siempre sugiere `C`, y Teams/Projects no ofrecen CTA contextual de creación.

La respuesta correcta es un patrón común de `Loading / Error + Retry / Empty + CTA`, y paginación o load-more en las vistas que ya conocen `pageInfo.hasNextPage`. No hace falta clonar los skeletons de Linear al píxel, pero sí conservar el camino de recuperación.

### 8. Accesibilidad y responsive

El responsive básico está resuelto, pero hay deuda transversal:

- Filas de issues y cards del board no son enfocables ni activables con Tab/Space.
- Drag & drop no tiene operación equivalente sin mouse.
- Modales/popovers no declaran completamente el patrón dialog ni gestionan foco.
- Los colores `--text-faint` (`#5c6067` dark, `#9a9ea6` light) tienen contraste insuficiente para texto normal; los textos secundarios deben reservarse para contenido no esencial o aclararse.
- En viewport estrecho la toolbar y las acciones de detalle deben conservar una ruta usable sin depender solo del overflow horizontal.

Esto debe entrar en la próxima tanda de calidad, no como una reescritura estética aislada.

## Deuda de documentación detectada

`docs/alcance-mvp.md` y `docs/specs/mvp.md` todavía describen como fuera de alcance relaciones, milestones, cycles, inbox, initiatives, custom views y status updates, aunque hoy existen en API/UI/CLI/MCP. Es documentación histórica válida para entender el origen, pero ya no alcanza como mapa de producto vigente. Conviene actualizarla o agregar un documento de alcance actual antes de la próxima tanda para que “faltante” no signifique “feature deliberadamente post-MVP”.

## Qué dejamos fuera deliberadamente

Estas diferencias con Linear son conscientes y no son bugs del clon:

- multi-workspace/switcher, por el modelo single-tenant;
- Documents, comentarios inline de documentos, adjuntos ricos y reacciones;
- Timeline/Roadmap, Insights/analytics y SLAs;
- Customer Requests/Asks, Releases/Diffs e integraciones enterprise;
- templates, recurring issues, estimates y due dates editables;
- personalización completa del sidebar, Pulse y superficies de AI/Agent que no sean necesarias para asignar trabajo a actores agentes;
- copiar cada atajo o detalle social de Linear cuando la API/CLI/MCP ofrece una ruta mejor para agentes.

La frontera correcta es: copiar **semántica, jerarquía y caminos de operación**; no copiar funcionalidades que agregan management o colaboración documental sin mejorar el ciclo agente → issue → evidencia → cierre.

## Orden recomendado

1. **P0 — Acciones y teclado:** selección/command menu/menú contextual con paridad lista-board.
2. **P0 — Filtros y display options:** exponer las propiedades que ya soporta la API y guardar layout/group/order/properties en todas las vistas.
3. **P0 — Datos confiables:** patrón loading/error+retry/empty+CTA y paginación/load-more para superar 250 resultados.
4. **P0 — Robustez y accesibilidad:** feedback de mutaciones, archive desde detalle, foco, contraste y alternativa de teclado al drag & drop.
5. **P1 — Saved Views:** crear/editar vistas sin contradicción de scope y con filtros reales.
6. **P1 — Project overview:** completar edición de properties/milestones y separar Overview/Issues.
7. **P1 — Inbox/My issues:** quick search, unread count y atajos básicos, manteniendo webhooks como canal principal de agentes.
8. **P2 — Sidebar personalizable:** ocultar/reordenar entradas y configurar el home del actor, solo cuando la navegación fija empiece a generar ruido.

## Fuentes y evidencia

### Código propio

- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/IssueList.tsx`
- `apps/web/src/components/IssueFilterToolbar.tsx`
- `apps/web/src/components/Palette.tsx`
- `apps/web/src/components/EntityModal.tsx`
- `apps/web/src/views/IssueView.tsx`
- `apps/web/src/views/ProjectView.tsx`
- `apps/web/src/views/SavedViewPage.tsx`
- `apps/web/src/issue-filter.ts`
- `apps/web/src/styles.css`
- `packages/schema/src/sdl.ts`
- `docs/alcance-mvp.md`, `docs/relevamiento-linear.md`, `docs/adr/0003-local-first-single-tenant.md`, `docs/adr/0011-favoritos-por-actor.md`

### Fuentes primarias de Linear

- [Start Guide](https://linear.app/docs/start-guide) — estructura general y flujo de uso.
- [Personalized sidebar](https://linear.app/changelog/2024-12-18-personalized-sidebar) y [Keyboard shortcuts help](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help) — personalización y descubrimiento de atajos.
- [Teams](https://linear.app/docs/teams) — workspace y pertenencia a teams.
- [Issue status](https://linear.app/docs/configuring-workflows) — workflows por team.
- [Select issues](https://linear.app/docs/select-issues) — resaltado, selección, acciones bulk y teclado.
- [Display options](https://linear.app/docs/display-options) — filtros de presentación, grouping, ordering, layout y propiedades visibles.
- [Board layout](https://linear.app/docs/board-layout) — paridad lista/board, columnas, selección, reordenamiento y swimlanes.
- [Create issues](https://linear.app/docs/creating-issues) y [Edit issues](https://linear.app/docs/editing-issues) — creación/edición y atajos.
- [Issue relations](https://linear.app/docs/issue-relations) y [Parent/sub-issues](https://linear.app/docs/parent-and-sub-issues) — relaciones y descomposición.
- [Custom Views](https://linear.app/docs/custom-views) y [Filters](https://linear.app/docs/filters) — guardar/compartir vistas y combinar filtros.
- [Search](https://linear.app/docs/search) y [Favorites](https://linear.app/docs/favorites) — búsqueda contextual, shortcuts personales y home.
- [Projects](https://linear.app/docs/projects), [Project overview](https://linear.app/docs/project-overview) y [Project milestones](https://linear.app/docs/project-milestones) — navegación y planificación de proyectos.
- [Inbox](https://linear.app/docs/inbox) y [Triage](https://linear.app/docs/triage) — notificaciones, búsqueda, snooze y clasificación.

## Tickets derivados

La auditoría no implementa cambios de producto. Los siguientes tickets separan el trabajo accionable:

- **PRB-279** — acciones de issues en lista, board y command menu.
- **PRB-280** — filtros y Display options.
- **PRB-281** — confiabilidad y accesibilidad de acciones de issues.
- **PRB-282** — ciclo de vida y scope de Saved Views.
- **PRB-283** — overview de proyectos y milestones.
- **PRB-284** — Inbox y My issues para seguimiento del actor.
- **PRB-285** — actualización del alcance vigente en la documentación.
- **PRB-286** — estados de carga/error/vacío, CTA y paginación.

## Verificación

- `bun run build` ✅
- La revisión no modificó código de producto; solo documenta diferencias y prioridades.
