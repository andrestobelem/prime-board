# Prime-board commands

Set the connection first:

```bash
export PRIME_BOARD_TEAM="${PRIME_BOARD_TEAM:-PB}"
alias pb='bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts"'
```

## Discover work

```bash
pb issue list --team "$PRIME_BOARD_TEAM" --unblocked --json
pb issue list --team "$PRIME_BOARD_TEAM" --assignee me --json
pb issue view PRB-123 --json
```

## Create and claim work

```bash
pb issue create --team "$PRIME_BOARD_TEAM" \
  --title "Short outcome" --description - --json
pb issue update PRB-123 --state started --assignee me --json
```

Use the team's actual state names or semantic state types. Do not assume that every Team uses
`PRB` or has the same visible state names.

## Report evidence and resolve

```bash
pb issue comment PRB-123 --body -
pb issue update PRB-123 --state completed --json
```

A comment should state the delivered behavior, validation commands, and remaining gaps. If a
new bug appears while working, create a separate issue first and reference it in the fix.

## Native dependencies

```bash
pb issue link PRB-123 --blocked-by PRB-122
pb issue list --team "$PRIME_BOARD_TEAM" --unblocked --json
```

Use `--related` for context without a dependency and `--duplicate-of` when an issue is
redundant. Do not encode blocking only in prose.
