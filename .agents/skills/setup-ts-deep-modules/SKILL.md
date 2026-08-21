---
name: setup-ts-deep-modules
description: Wire dependency-cruiser into a TypeScript repo so each package is a deep module — implementation hidden in subfolders, reachable only through its entry-point files. User-invoked.
disable-model-invocation: true
---

# Setup TS Deep Modules

Make every package in this repository a **deep module**: place substantial behavior behind a small interface. A package's public surface is its **entry points**, the files at the package root. Hide everything in subfolders. This skill installs [dependency-cruiser](https://github.com/sverweij/dependency-cruiser), enforces entry-point imports, and verifies the rules.

For the vocabulary (deep module, interface, seam, depth), call the Skill tool with "codebase-design". Use that vocabulary throughout.

## The shape this enforces

```
src/packages/
  <name>/
    index.ts        ← an entry point (public). Import this from outside.
    client.ts       ← another entry point. Packages may expose SEVERAL.
    lib/            ← implementation: hidden from outside, free to import each other.
    tests/          ← co-located tests + fixtures (a subfolder, so private).
```

The public surface is every package **root file**, not one designated `index.ts`. By convention, put implementation in `lib/` and tests in `tests/`. This gives packages a consistent shape. The rule is general: *anything* in *any* subfolder is private. Never extend the config to add a folder.

Enforce four rules, all with `error`:

1. **Entry-point boundary** — code outside a package (app code or another package) may import only that package's entry points (its root files), never anything in its subfolders.
2. **Intra-package freedom** — a package's own files import each other freely.
3. **Tests through the entry points** — files under `<pkg>/tests/` may import any package's entry points and their own `tests/` fixtures, but never any package's subfolder internals (not even their own). Integration tests across packages are fine; deep imports are not.
4. **No cycles** — no dependency cycles.

**Entry points, not a barrel.** Because every root file is public, a package can expose several small entry points (`index.ts`, `client.ts`, `server.ts`) instead of routing everything through one large `index.ts`. Avoid barrel files that re-export a whole subtree. Keep entry points small and hide implementation in subfolders.

Layering, which defines package dependencies, is a *different* concern. The config leaves it as a commented stub for this repository to define.

## Steps

### 1. Detect the environment

- **Package manager** — `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, otherwise npm. Use the detected manager for every command below (`pnpm`/`yarn`/`npm run`/`bunx`).
- **Packages root** — use `src/packages` when `src/` exists; otherwise use `packages`. Confirm this choice with the user when the repository has another clear convention.
- **Existing config** — check for a `.dependency-cruiser.*` file. If one exists, do **not** overwrite it. Merge in the four rules and options, then tell the user what you added.

**Done when:** package manager, packages root, and existing-config status are all known.

### 2. Install dependency-cruiser

Install `dependency-cruiser` as a devDependency with the detected package manager.

**Done when:** `dependency-cruiser` is in `devDependencies`.

### 3. Write the config

Copy [`dependency-cruiser.config.cjs`](./dependency-cruiser.config.cjs) to the repository root as `.dependency-cruiser.cjs`. Set `PACKAGES_ROOT` to the root detected in step 1. The rules use path depth and do not depend on file extensions, so no other changes are needed.

**Done when:** `.dependency-cruiser.cjs` exists with the correct `PACKAGES_ROOT`, and the four forbidden rules are present.

### 4. Wire it into the checks

- Add a `lint:boundaries` script: `depcruise <packages-root>` (or `depcruise src`).
- Add it to the repository's umbrella check command, the command that already runs typecheck (for example, a `check` / `ci` / `validate` script). Do **not** change `tsconfig` or add path aliases.
- If no umbrella script exists, add `lint:boundaries` and tell the user to include it in CI.

**Done when:** `lint:boundaries` exists and runs as part of the same command as typecheck.

### 5. Scaffold the example package

Create a committed `<packages-root>/example/` as a template to copy:

- `index.ts` — an entry point. Export one function that delegates to an internal file (so the package is visibly *deep*, not a pass-through).
- `lib/impl.ts` — an internal file in a **subfolder**, imported by `index.ts`, not reachable from outside.
- `tests/example.test.ts` — imports **only** `../index` (an entry point), and asserts against the public function.

Tell the user that this is a starter template to copy or delete.

**Done when:** the example package exists, exposes its behaviour through a root entry point, and hides `impl` in a subfolder.

### 6. Prove the rules bite

This is the completion criterion for the skill. A config that does not fail on a violation is not valid.

1. Run `lint:boundaries`. It must **pass** on the clean example.
2. Temporarily add a deep import to `tests/example.test.ts` (for example, `import { thing } from "../lib/impl"`). Run `lint:boundaries` again. It must **fail** with `tests-through-entrypoints`.
3. Revert the deep import. Run the command once more. It must **pass**.

**Done when:** you have observed a pass, then a fail on the deep import, then a pass again. If step 2 does not fail, the rules are not wired correctly — fix before finishing.

### 7. Document the convention

Write a `README.md` **in the packages folder** (`<packages-root>/README.md`), next to the packages it governs. Cover the `src/packages/<name>/` layout (entry points at the root, `lib/` for implementation, `tests/` for tests), "import only through a package's entry points (its root files)", and how to run `lint:boundaries`. **Discourage barrel files** explicitly. Expose several small entry points instead of re-exporting a whole subtree through one index. Limit the document to the copy-me snippet and one paragraph for each rule.

Then add a **context pointer** to the README from the repository's agent-instructions file: `CLAUDE.md` if present, otherwise `AGENTS.md` (create `AGENTS.md` if neither exists). One line is enough, for example, `Packages are deep modules — see [src/packages/README.md](./src/packages/README.md) before adding or importing one.` This lets agents discover the boundary rule.

**Done when:** `<packages-root>/README.md` exists and discourages barrels, and the repo's `CLAUDE.md`/`AGENTS.md` links to it.

## Notes

- The config's `$1` back-references (dependency-cruiser's group matching) let a package reach its own internals while outsiders cannot. Do not flatten them into separate per-package rules.
- Public vs private is decided by **depth**: root files are entry points; subfolder files are private. The conventional subfolders are `lib/` (implementation) and `tests/`, but the rule does not hardcode them. Every subfolder is private, so new folders require no config change. Add an entry point by adding a root file, not a barrel.
- Packages are **flat**: one tier of immediate children under the root. Package internals can nest as needed. A package cannot contain another package.
- Use `.cjs` (not `.js`) so `module.exports` works in repos with `"type": "module"`.
