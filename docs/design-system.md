# Design system de la UI web

Referencia visual de `apps/web`: tokens, temas, tipografía, componentes, iconografía y
patrones, con los valores exactos del código. Última sincronización: 2026-08-26, incluye PRB-565 y la
escala tipográfica de PRB-557.

**Fuente de verdad** (este documento se deriva de ahí; ante una diferencia, gana el código):

- `apps/web/src/styles.css`: tokens semánticos y todos los estilos de componentes.
- `apps/web/src/theme.ts`: preferencias de tema, resolución de `system` y persistencia.
- `apps/web/src/components/icons.tsx`: set de íconos (Lucide vendorizado + custom).
- `apps/web/src/components/bits.tsx`: piezas chicas (prioridad, estado, avatar, label).

**Canvas editable**: <https://claude.ai/code/artifact/28b69d6d-ee20-4459-87f5-c86108110060>
(láminas Fundamentos, Temas, Componentes, Iconos y Patrones; privado, se comparte desde el
menú de la página). Copia local en
[design-system/prime-board-design-system.html](design-system/prime-board-design-system.html)
— se abre en el navegador como canvas de solo lectura con export PNG/PDF; las fuentes de las
láminas (`*.dc.html` y `canvas.json`) están en el mismo directorio.

Para el origen de la paleta y su licencia, ver [research/catppuccin.md](research/catppuccin.md)
y [licenses/catppuccin-MIT.txt](licenses/catppuccin-MIT.txt).

## Tokens semánticos

El tema activo se resuelve en `html[data-theme]`; Mocha es el fallback seguro y el valor de
`:root`. Valores en Catppuccin Mocha (tema oscuro por defecto):

| Token               | Valor                                 | Uso                                  |
| ------------------- | ------------------------------------- | ------------------------------------ |
| `--bg`              | `#1e1e2e`                             | Fondo del contenido                  |
| `--bg-sidebar`      | `#181825`                             | Sidebar, popovers, columnas de board |
| `--surface`         | `#313244`                             | Inputs, cards, tabs, kbd             |
| `--surface-hover`   | `#45475a`                             | Hover de filas y menús, tab activa   |
| `--border`          | `#585b70`                             | Bordes de controles y menús          |
| `--border-subtle`   | `#45475a`                             | Separadores de filas y paneles       |
| `--text`            | `#cdd6f4`                             | Texto principal                      |
| `--text-muted`      | `#bac2de`                             | Texto secundario, controles          |
| `--text-faint`      | `#a6adc8`                             | Metadatos, etiquetas de sección      |
| `--accent`          | `#cba6f7`                             | Acciones primarias, foco, marca      |
| `--accent-hover`    | `#b4befe`                             | Hover del accent                     |
| `--accent-contrast` | `#1e1e2e`                             | Texto sobre accent                   |
| `--danger`          | `#f38ba8`                             | Errores y acciones destructivas      |
| `--selection`       | `color-mix(#9399b2 25%, transparent)` | Ítem seleccionado en listas          |
| `--radius`          | `6px`                                 | Radio base                           |
| `--radius-sm`       | `4px`                                 | Controles compactos y teclas         |
| `--radius-md`       | `8px`                                 | Menús, popovers y tarjetas           |
| `--radius-lg`       | `10px`                                | Modales y badges                     |
| `--radius-pill`     | `999px`                               | Estados en forma de píldora          |
| `--radius-round`    | `50%`                                 | Avatares y puntos                    |
| `--radius-none`     | `0`                                   | Inputs sin radio                     |
| `--shadow-popup`    | `0 8px 24px rgb(0 0 0 / 30%)`         | Menús de workspace                   |
| `--shadow-popover`  | `0 16px 40px rgb(0 0 0 / 35%)`        | Popovers y menús de issue            |
| `--shadow-modal`    | `0 16px 60px rgb(0 0 0 / 50%)`        | Modales y switcher                   |
| `--shadow-drawer`   | `12px 0 40px rgb(0 0 0 / 35%)`        | Drawer móvil                         |
| `--shadow-focus`    | `inset 2px 0 0 var(--accent)`         | Fila de issue enfocada               |

Derivados: `--danger-bg` y `--danger-border` son `color-mix` del danger al 12 % y 40 %;
`--danger-text` es el danger pleno.

### Estados del workflow

| Token                | Mocha     | Estado      |
| -------------------- | --------- | ----------- |
| `--status-triage`    | `#fab387` | Triage      |
| `--status-backlog`   | `#6c7086` | Backlog     |
| `--status-unstarted` | `#bac2de` | Todo        |
| `--status-started`   | `#f9e2af` | In Progress |
| `--status-completed` | `#a6e3a1` | Done        |
| `--status-canceled`  | `#6c7086` | Canceled    |

`--priority-urgent` comparte el valor de `--status-triage`. Urgent es el único nivel de
prioridad con color propio; el resto usa `--text-muted`.

## Temas

Seis temas; los mismos tokens cambian de valor. La preferencia `system` resuelve a Mocha
(oscuro) o Latte (claro) según `prefers-color-scheme`. `dark` y `light` (estética Linear) se
conservan solo para preferencias ya guardadas.

| Tema           | `data-theme`           | bg        | surface   | border    | text      | accent    | danger    |
| -------------- | ---------------------- | --------- | --------- | --------- | --------- | --------- | --------- |
| Mocha          | `catppuccin-mocha`     | `#1e1e2e` | `#313244` | `#585b70` | `#cdd6f4` | `#cba6f7` | `#f38ba8` |
| Macchiato      | `catppuccin-macchiato` | `#24273a` | `#363a4f` | `#5b6078` | `#cad3f5` | `#c6a0f6` | `#ed8796` |
| Frappé         | `catppuccin-frappe`    | `#303446` | `#414559` | `#626880` | `#c6d0f5` | `#ca9ee6` | `#e78284` |
| Latte          | `catppuccin-latte`     | `#eff1f5` | `#ccd0da` | `#acb0be` | `#4c4f69` | `#8839ef` | `#d20f39` |
| Dark (legacy)  | `dark`                 | `#0f1011` | `#17181b` | `#26282d` | `#e2e3e5` | `#5e6ad2` | `#eb5757` |
| Light (legacy) | `light`                | `#ffffff` | `#f1f2f4` | `#d9dbdf` | `#282a30` | `#5e6ad2` | `#d94b4b` |

La tabla completa (sidebar, hover, muted, statuses) está en `styles.css` y en la lámina
"Temas" del canvas.

## Tipografía

Inter con fallback `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
sans-serif`; base 16px / line-height 1.4, antialiased. PRB-557 subió la escala visible.

| Tamaño | Peso    | Uso                                                                                                                                                                             |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 28px   | 700     | Títulos de página (`.teams-page h1`, `.projects-page h1`, `.team-home-header h1`)                                                                                               |
| 22px   | 700     | Encabezado de settings (`letter-spacing: -0.2px`)                                                                                                                               |
| 20px   | 600     | Título de issue (`.issue-title-input`); h1 de página                                                                                                                            |
| 16px   | 700     | Títulos de modal y de panel (`.modal-header h2`, `.settings-panel-header h2`)                                                                                                   |
| 16px   | 400     | **Base**: body, filas de issues, navegación del sidebar, formularios                                                                                                            |
| 15px   | 400–500 | **Controles**: `.btn`, tabs, menús, toolbars, switcher, palette                                                                                                                 |
| 14px   | 400–600 | **Metadatos y encabezados de grupo**: identifiers, `.comment .meta`, `.state-group-header`, `.board-column .col-header`, `.section-title`, actividad, descripciones de settings |
| 13px   | 500     | `.btn.compact`, `.board-card .card-title`                                                                                                                                       |
| 12px   | 400–600 | Código inline Markdown y labels de propiedades compactos                                                                                                                        |
| 11px   | 500     | Labels compactos: `.label-chip`, `.sidebar .section` (uppercase, ls 0.4px), `.nav-count`                                                                                        |
| 10px   | 600     | `kbd`, `.workspace-team-key` (mono: `ui-monospace, SFMono-Regular, Menlo, …`)                                                                                                   |

El Board conserva una densidad intencional para facilitar el escaneo de muchas tarjetas:
`.board-card` usa 13px para el título, 11px para el identifier y chips, y la escala de 12px
solo se usa en código inline o labels compactos. El encabezado de cada columna sí usa la escala
canónica de 14px, igual que `.state-group-header`.

## Forma, profundidad y medidas

- **Radios**: todos los radios de `styles.css` usan tokens. La escala es 4px
  (`--radius-sm`), 6px (`--radius`, base), 8px (`--radius-md`) y 10px (`--radius-lg`).
  `--radius-pill` (999px), `--radius-round` (50%) y `--radius-none` (0) cubren píldoras,
  formas circulares e inputs sin radio.
- **Sombras**: `--shadow-popup`, `--shadow-popover`, `--shadow-modal`, `--shadow-drawer` y
  `--shadow-focus` son los únicos valores de `box-shadow` permitidos.
- **Foco**: `:focus-visible` aplica `outline: 2px solid var(--accent)` con offset 2px a
  inputs, selects, textareas y botones por igual. El borde de controles enfocados también pasa
  a `--accent`.
- **Botones-ícono**: `.icon-button` mide 28×28px en desktop. En el breakpoint de 720px
  mide 44×44px para cumplir el área táctil mínima. No hay clases alternativas para este rol.
- **Medidas de layout**: sidebar 220px; panel de propiedades del issue 260px; columna de
  board 280px; ancho máximo de páginas 760–980px según vista.
- **Breakpoint móvil**: 720px (sidebar como drawer, toolbars apiladas, chips ocultos en filas).

### Decisiones técnicas de PRB-565

- La densidad compacta del contenido de las tarjetas del Board se conserva. La decisión protege
  la lectura rápida de varias tarjetas sin cambiar la estética Catppuccin ni el layout existente.
  Los encabezados de columna no son una excepción y usan 14px.
- El tamaño único de `.icon-button` es 28px en desktop. En móvil se amplía a 44px sin cambiar
  el icono visual. Esto mantiene la composición desktop y mejora la interacción táctil.

## Componentes (valores exactos)

- **`.btn`**: fondo `--accent`, texto `--accent-contrast`, radio `--radius`, padding `5px 12px`,
  15px/500, `inline-flex` con gap 5. Hover: `--accent-hover`. Variantes: `.secondary`
  (fondo `--surface`, borde `--border`, texto `--text`), `.danger` (fondo `--danger`),
  `.compact` (padding `4px 8px`, 13px).
- **`.icon-button`**: 28×28, radio `--radius`, borde transparente; en hover fondo `--surface` y
  borde `--border`.
- **Inputs / select / textarea**: heredan la fuente (16px), fondo `--surface`, borde 1px
  `--border`, radio `--radius`, padding `6px 8px`; en foco el borde pasa a `--accent`. En toolbars
  bajan a 15px.
- **`.tabs`**: contenedor con fondo `--surface`, radio 6px, padding 2px; botones
  `3px 10px`, radio `--radius-sm`, 15px, texto muted; la activa usa `--surface-hover` y `--text`.
- **`kbd`**: fondo `--surface`, borde `--border`, radio `--radius-sm`, padding `0 4px`, 10px.
- **`.label-chip`**: alto 18px, radio `--radius-lg`, padding `0 8px`, 11px muted; borde y punto
  (7×7) del color del label.
- **`.avatar`**: 18×18 redondo, fondo `--surface-hover`, borde `--border`, iniciales
  9px/600; agente: borde y contenido en `--accent` con ícono `bot` a 11px.
- **Badges**: `.nav-count` (radio `--radius-lg`, fondo `--accent`, texto `--accent-contrast`, 11px), `.filter-count` (16px de
  alto, fondo `--accent`, texto `--accent-contrast`, 10px), `.workspace-team-status`
  (pill `--radius-pill`, color del estado al 35 %/10 % en borde/fondo, 10px/600, punto 6px),
  `.default-badge` (texto y borde `--accent`, radio `--radius-sm`).
- **`.error-banner`**: fondo `--danger-bg`, borde `--danger-border`, texto `--danger-text`,
  radio `--radius`, padding `10px 12px`.

## Iconografía

Set monocromo definido en `icons.tsx`: trazos de Lucide vendorizados (licencia ISC en el
propio archivo) más tres custom dibujados en el mismo grid: `workspace` (monograma P′),
`state-in-progress` (torta) y `priority-none`. Convenciones:

- Grid nativo 24×24, `stroke-width: 2`, `stroke-linecap/linejoin: round`, `fill: none`.
- Color siempre por `currentColor`; nada de colores hardcodeados en los paths.
- Tamaño típico 16px; 18px para la marca en el sidebar, 11–14px en usos compactos.
- `StateIcon` pinta el color según el tipo de workflow (tabla de estados de arriba);
  `PriorityIcon` solo destaca Urgent.

Vocabulario (42): workspace, bot, issues, team-key, project, file-text, milestone, members,
settings, board, search, plus, tag, assignee, calendar, archive, filter, sort, menu, more,
comment, link, copy, chevron-right, chevron-down, arrow-up, arrow-down, check, x, sun, moon;
prioridad (urgent/high/medium/low/none) y estados (triage/backlog/todo/in-progress/done/
canceled).

## Patrones

- **Lista de issues**: `.state-group-header` (fondo `--surface`, 14px/600, sticky) agrupa
  `.issue-row` (padding `7px 16px`, gap 10, separador `--border-subtle`): prioridad,
  identifier (14px faint, ancho 64px, truncado seguro), estado, título, y a la derecha chips y avatar. La
  fila enfocada usa `--surface-hover` más `box-shadow: var(--shadow-focus)`.
- **Sidebar**: fondo `--bg-sidebar`, ítems de 16px muted con radio 6px y hover
  `--surface-hover`; secciones en 11px uppercase; "New issue" como botón con borde y kbd.
- **Board**: columnas de 280px con fondo `--bg-sidebar` y radio `--radius-md`; cards con fondo
  `--surface`, borde `--border-subtle`, radio 6px, padding 10px (identifier 11px, título
  13px/500, footer con estado/chip/avatar).
- **Comentarios**: caja con borde `--border-subtle` y radio 6px; meta en 14px faint con
  autor 600; cuerpo con line-height 1.6. Composer: textarea de 70px mínimo y botón primario
  alineado a la derecha.

## Resultado de PRB-565 (revisión 2026-08-26)

- El identifier de las listas usa 64px, una línea y truncado con ellipsis. En móvil queda
  limitado a 30% para evitar solapamiento con el título. Este criterio ya se entregó en PRB-559.
- `.nav-count` usa `--accent-contrast`, igual que `.filter-count`, para conservar contraste AA
  en los seis temas.
- Radios y sombras usan solo los tokens declarados.
- `.icon-button` es la única clase del rol. Su área es 28px en desktop y 44px en móvil.
- Inputs, selects, textareas y botones comparten el anillo de foco visible por teclado.
