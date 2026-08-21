---
name: git-guardrails-claude-code
description: Set up Claude Code hooks to block dangerous git commands (push, reset --hard, clean, branch -D, etc.) before they execute. Use when user wants to prevent destructive git operations, add git safety hooks, or block git push/reset in Claude Code.
---

# Setup Git Guardrails

Set up a PreToolUse hook that intercepts and blocks dangerous git commands before Claude executes them.

## What Gets Blocked

- `git push` (all variants including `--force`)
- `git reset --hard`
- `git clean -f` / `git clean -fd`
- `git branch -D`
- `git checkout .` / `git restore .`

When a command is blocked, Claude receives a message that it does not have authority to run the command.

## Steps

### 1. Ask scope

Ask the user whether to install the hook for **this project only** (`.claude/settings.json`) or **all projects** (`~/.claude/settings.json`).

### 2. Copy the hook script

The bundled script is [scripts/block-dangerous-git.sh](scripts/block-dangerous-git.sh).

Copy it to the location for the selected scope:

- **Project**: `.claude/hooks/block-dangerous-git.sh`
- **Global**: `~/.claude/hooks/block-dangerous-git.sh`

Make the copied script executable with `chmod +x`.

### 3. Add hook to settings

Add the hook to the settings file for the selected scope:

**Project** (`.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/block-dangerous-git.sh"
          }
        ]
      }
    ]
  }
}
```

**Global** (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/block-dangerous-git.sh"
          }
        ]
      }
    ]
  }
}
```

If the settings file exists, merge the hook into its `hooks.PreToolUse` array. Do not overwrite other settings.

### 4. Ask about customization

Ask whether the user wants to add or remove patterns from the blocked list. Edit the copied script accordingly.

### 5. Verify

Run a quick test:

```bash
echo '{"tool_input":{"command":"git push origin main"}}' | <path-to-script>
```

The command must exit with code 2 and print a BLOCKED message to stderr.
