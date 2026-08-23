# Catppuccin

## Uso en prime-board

prime-board usa los cuatro flavors oficiales como temas de UI:

- **Latte** (`latte`): flavor claro.
- **Frappé** (`frappe`): flavor oscuro moderado.
- **Macchiato** (`macchiato`): flavor oscuro de contraste medio.
- **Mocha** (`mocha`): flavor oscuro más profundo.

La preferencia `system` resuelve a Latte cuando el sistema usa un esquema claro y a Mocha
cuando usa un esquema oscuro. Los ids de los temas son locales a prime-board y no requieren
una petición de red en tiempo de ejecución.

## Mapeo semántico

El CSS usa tokens semánticos de prime-board. Los valores proceden de la paleta oficial:

| Token de prime-board            | Color Catppuccin                 |
| ------------------------------- | -------------------------------- |
| `--bg`                          | `Base`                           |
| `--bg-sidebar`                  | `Mantle`                         |
| `--surface` / `--surface-hover` | `Surface 0` / `Surface 1`        |
| `--border`                      | `Surface 2`                      |
| `--text`                        | `Text`                           |
| `--text-muted` / `--text-faint` | `Subtext 1` / `Subtext 0`        |
| `--accent`                      | `Mauve`                          |
| `--accent-hover`                | `Lavender`                       |
| `--danger`                      | `Red`                            |
| `--status-completed`            | `Green`                          |
| `--status-started`              | `Yellow`                         |
| `--status-triage`               | `Peach`                          |
| `--selection`                   | `Overlay 2` con 25 % de opacidad |

Los colores de `Label` que llegan desde la API siguen siendo datos del Workspace. No se
reemplazan por tokens del tema.

## Fuentes oficiales

- [Catppuccin palette](https://github.com/catppuccin/palette/blob/main/palette.json): valores
  canónicos de los 26 colores por flavor.
- [Catppuccin specs](https://github.com/catppuccin/catppuccin/blob/main/docs/specs.md): definición
  de flavors y sub-paletas.
- [Catppuccin style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md):
  uso semántico y guía de contraste.
- [Catppuccin website](https://catppuccin.com/palette/): presentación pública de la paleta.

## Licencia y atribución

Catppuccin y su paleta se distribuyen bajo la licencia MIT. La copia del aviso oficial está en
[`docs/licenses/catppuccin-MIT.txt`](../licenses/catppuccin-MIT.txt). La atribución conserva el
nombre Catppuccin y enlaza a su repositorio oficial.
