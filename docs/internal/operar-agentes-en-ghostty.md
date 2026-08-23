# Operar agentes de Prime Agent en splits de Ghostty

> Uso interno. Evidencia: [PRB-521](http://localhost:3333/issue/PRB-521).
> Este documento no contiene API keys.

## Objetivo

Lanzar varias sesiones de Prime Agent en una ventana de Ghostty. Cada sesión usa un
Actor distinto del Team `PRB`. La sesión principal usa `admin`. Las sesiones auxiliares
usan `Scout`, `Builder` y `ghostty-scout`.

El nombre de la sesión de Prime Agent no prueba la identidad del Actor. La identidad se
valida con `pb auth status --json`.

## Requisitos

- Una instancia aislada de prime-board activa para el repositorio.
- `prime-agent` y `bun` disponibles en el `PATH`.
- Una API key válida por Actor.
- Membership activa en el Team `PRB`.
- Las API keys guardadas fuera del repositorio, por ejemplo en `~/.prime-board/`.

Inicia la instancia si no está activa:

```bash
cd /Users/andrestobelem/ws/at/prime-board
bun scripts/prime-board-project.ts --project "$PWD"
```

Configura el contexto común en cada proceso:

```bash
export PRIME_BOARD_URL=http://127.0.0.1:3333
export PRIME_BOARD_TEAM=PRB
export PRIME_BOARD_ROOT=/Users/andrestobelem/ws/at/prime-board
```

No guardes `PRIME_BOARD_API_KEY` en el repositorio ni en una réplica `.prime-board/`.

## Preparar un launcher por Actor

Usa un archivo con permisos `0700` para cada launcher. El archivo debe vivir fuera del
repositorio. El secreto se escribe en el archivo local una sola vez y nunca se copia a
la documentación, al historial de Git ni a los logs públicos.

Ejemplo para `Scout`:

```zsh
#!/bin/zsh
export PRIME_BOARD_URL="http://127.0.0.1:3333"
export PRIME_BOARD_API_KEY="<key de Scout>"
export PRIME_BOARD_TEAM="PRB"
cd "/Users/andrestobelem/ws/at/prime-board"
exec prime-agent --cwd "/Users/andrestobelem/ws/at/prime-board" \
  --append-system-prompt "You are the prime-board product agent Scout. Use PRIME_BOARD_API_KEY for board operations. Start by verifying your identity and assigned PRB issues, then wait." \
  -- "Confirm that Scout is authenticated to prime-board, show your identity and assigned PRB issues, then wait."
```

Crea launchers equivalentes para `Builder` y `ghostty-scout`. Cambia el nombre y la
API key en cada archivo. Añade instrucciones de trabajo específicas si el Actor tiene
un rol operativo, por ejemplo:

- `Scout`: investigar, diagnosticar y reunir evidencia.
- `Builder`: implementar cambios y ejecutar validaciones.
- `ghostty-scout`: hacer QA, reproducir errores y verificar resultados.

Protege los archivos:

```bash
chmod 700 ~/.prime-board/launch-scout.zsh
chmod 700 ~/.prime-board/launch-builder.zsh
chmod 700 ~/.prime-board/launch-ghostty-scout.zsh
```

## Validar cada credencial

Valida cada key antes de abrir un split. No muestres la variable en la salida:

```bash
PRIME_BOARD_API_KEY="<key de Scout>" \
  bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts" auth status --json

PRIME_BOARD_API_KEY="<key de Builder>" \
  bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts" auth status --json

PRIME_BOARD_API_KEY="<key de ghostty-scout>" \
  bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts" auth status --json
```

La respuesta debe identificar al Actor esperado. Comprueba también el roster:

```bash
pb team membership-list PRB --json
```

`auth status` necesita el scope `READ`. Si una key solo tiene `WRITE`, crea una nueva
key limitada al Team:

```bash
pb api-key create \
  --actor ghostty-scout \
  --name "Ghostty Scout operational key" \
  --scopes read,write \
  --team PRB \
  --json
```

El CLI muestra el secreto una sola vez. Cópialo al launcher local y no lo incluyas en
un comentario, captura, commit o archivo del repositorio.

Los scopes de una key y el rol de Membership son capas distintas. La key no convierte
un `MEMBER` en `OWNER` ni en Workspace Admin.

## Crear splits a la derecha

Ghostty usa estos atajos por defecto:

```text
super+d              new_split:right
super+shift+d        new_split:down
```

Selecciona primero la ventana de Ghostty que contiene la sesión principal. Luego crea
un split a la derecha y ejecuta un launcher. Repite la operación sobre el nuevo panel:

```applescript
 tell application "Ghostty" to activate
 tell application "System Events"
  tell process "Ghostty"
   set frontmost to true
   keystroke "d" using {command down}
   delay 0.4
   keystroke "/Users/andrestobelem/.prime-board/launch-scout.zsh"
   key code 36
  end tell
 end tell
```

Repite el bloque con estos launchers, en este orden:

1. `launch-scout.zsh`
2. `launch-builder.zsh`
3. `launch-ghostty-scout.zsh`

El resultado esperado es una ventana con cuatro paneles verticales:

```text
admin | Scout | Builder | ghostty-scout
```

Si la ventana está en otro Space, selecciónala desde Mission Control antes de enviar
el atajo. Si el comando aparece en una terminal normal en vez de crear un split,
interrumpe la operación y selecciona la ventana correcta.

## Verificar las sesiones

Lista las sesiones de Prime Agent y comprueba que las tres nuevas estén vivas:

```bash
prime-agent list --all --json
```

Busca estas condiciones:

- `cwd` apunta al checkout de `prime-board`.
- `lifecycle` es `live`.
- `attachedClients` es mayor que cero.
- El mensaje inicial corresponde al Actor esperado.
- La sesión está `idle` después de mostrar su identidad y sus Issues asignadas.

La validación de identidad se hace desde el mismo entorno de cada launcher. No se debe
inferir a partir del modelo (`GPT-5.6 Luna`) ni del título de la ventana.

## Registro operativo

Para una operación reproducible, registra en el Issue operativo:

- URL y puerto de la instancia, sin API keys.
- Actors usados y orden de los paneles.
- Resultado de `auth status --json` sin secretos.
- Resultado resumido de `prime-agent list --all --json`.
- Rotaciones de keys, indicando scopes y Team, pero no el secreto.
- Problemas conocidos y acciones de limpieza pendientes.

Las operaciones de creación, rotación o revocación de keys pasan por la API de
prime-board. No edites `.prime-board/` a mano.
