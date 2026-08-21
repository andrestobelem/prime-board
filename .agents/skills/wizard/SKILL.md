---
name: wizard
description: Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover. Don't invoke this for steps the agent can perform itself.
---

# Wizard

A **wizard** is a bash script that guides a human through a manual procedure. Use it for work that is tedious to perform or to explain repeatedly. The script opens each URL, states what to click and copy, captures values, writes them to their destinations (`.env`, GitHub secrets), confirms each stage, and reports the remaining stages. It can configure third-party services, run a one-off migration, or move a project between states.

[template.sh](template.sh) provides the user experience: stage progress, confirmation gates, cross-platform URL opening (including WSL), hidden secret entry, idempotent `.env` upserts, `gh secret`/`gh variable` writes, and a closing summary. **Your job is only to scope the procedure and author its stages.** The library above the `STAGES` marker is identical in every wizard. Keep that consistency. Never edit the library manually.

A wizard is ephemeral by default. Build it for one run, save it to a scratch or `scripts/` path, and delete it when the job is complete. Commit it only when the user wants a repeatable setup path in the repository.

## Process

### 1. Scope the procedure

Identify every manual step the human must take and every value the wizard captures. Read the repository first. Do not ask without checking:

- For setup: `.env`, `.env.example`, `.env.*`, `README`, `docker-compose*`, framework config, and `.github/workflows/*` (every `secrets.*` / `vars.*` reference is a value the wizard must produce).
- For a migration or transition: the current state, the target state, and the irreversible actions between them.

Show the user the ordered stages and the values each stage produces. Ask for confirmation. The user can add, remove, or reorder stages.

**Done when:** every stage has an order, and for each captured value you know (a) where the human gets it, (b) where it is written (`.env`, a GitHub secret, both, or nowhere — some stages are pure actions), and (c) whether it is secret (hidden entry) or public.

### 2. Map each stage's journey

For each stage, write the exact path a human follows: the URL to open, the action to take, where the value appears, and the variable it fills. For example, "Dashboard → Developers → API keys → Reveal test key → copy". If you do not know the current UI or exact command, state that and ask the user or check the documentation. Never invent steps.

**Done when:** every stage has concrete instructions that a person unfamiliar with the procedure can follow.

### 3. Author the wizard

Copy `template.sh` to the target path. Replace the example stage with one `stage` for each step, in dependency order. Use the library helpers — `stage`, `say`/`step`, `open_url`, `ask`/`ask_secret`, `write_env`, `set_secret`/`set_var`, `pause`/`confirm` — and set `TOTAL_STAGES` to the number of stages.

Follow the template rules: open the URL before asking for its value; use `ask_secret` for secrets; call `write_env` for every persisted value; call `set_secret` only for values CI needs; and call `confirm` before irreversible actions. Each `stage` clears the screen and shows only the current step. Keep one focused task per stage so required information stays visible. Do not edit the library above the marker.

### 4. Verify and hand off

- Run `bash -n <script>` and `shellcheck` when available.
- Run `chmod +x <script>`.
- Do not run the wizard end to end. It opens browsers and waits for human input. Trace it statically instead: confirm that every value from step 1 is captured and written where step 1 specified, and that every `set_secret` name exactly matches a `secrets.*` reference in CI.
- Tell the user how to run the wizard. If it is a repeatable setup path, commit it and link it from the README so the next person can run it without asking an AI.
