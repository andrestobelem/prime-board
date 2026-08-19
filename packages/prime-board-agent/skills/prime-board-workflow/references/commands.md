# Comandos de prime-board

Configura primero la conexión:

```bash
export PRIME_BOARD_TEAM="${PRIME_BOARD_TEAM:-PRB}"
alias pb='bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts"'
```

## Descubrir trabajo

```bash
pb issue list --team "$PRIME_BOARD_TEAM" --unblocked --json
pb issue list --team "$PRIME_BOARD_TEAM" --assignee me --json
pb issue view PRB-123 --json
```

## Crear y reclamar

```bash
pb issue create --team "$PRIME_BOARD_TEAM" \
  --title "Resultado breve" --description - --json
pb issue update PRB-123 --state started --assignee me --json
```

Usa los nombres de estado reales del Team o sus tipos semánticos. No supongas que todos los
Teams tienen los mismos nombres visibles ni que la clave es `PRB`.

## Informar evidencia y resolver

```bash
pb issue comment PRB-123 --body -
pb issue update PRB-123 --state completed --json
```

El comentario debe indicar el comportamiento entregado, los comandos de validación y las
brechas restantes. Si aparece un error nuevo mientras trabajas, crea primero un Issue separado
y referencia el arreglo.

## Dependencias nativas

```bash
pb issue link PRB-123 --blocked-by PRB-122
pb issue list --team "$PRIME_BOARD_TEAM" --unblocked --json
```

Usa `--related` para contexto sin bloqueo y `--duplicate-of` cuando un Issue sea redundante.
No codifiques los bloqueos solo en prosa.
