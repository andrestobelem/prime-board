---
name: prototype
description: Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.
---

# Prototype

A prototype is **throwaway code that answers one question**. The question determines its shape.

## Pick a branch

Identify the question to answer from the user's prompt or surrounding code. Ask the user when available:

- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md). Build one shareable HTML file with free-play buttons and tabbed guided walkthroughs. Use it to exercise state-machine cases that are difficult to reason about on paper. A non-developer must be able to use it.
- **"What should this look like?"** → [UI.md](UI.md). Generate several radically different UI variations on one route. Switch between them with a URL search param and a floating bottom bar.

The two branches produce different artifacts. Choosing the wrong branch invalidates the prototype. If the question is ambiguous and the user is unavailable, choose the branch that matches the surrounding code (a backend module → logic; a page or component → UI). State the assumption at the top of the prototype.

## Rules that apply to both

1. **Mark it as throwaway from day one.** Put the prototype code near the module or page it explores. Name it so readers can distinguish it from production code. For throwaway UI routes, follow the project's routing convention. Do not create a new top-level structure.
2. **Make it trivial to run.** A UI prototype starts with one command in the project's task runner — `pnpm <name>`, `python <path>`, `bun <path>`, etc. A logic demo is one HTML file that the user can open directly.
3. **Use no persistence by default.** Keep state in memory. The prototype checks persistence; it does not depend on persistence. If the question requires a database, use a scratch database or a local file with a clear "PROTOTYPE — wipe me" name.
4. **Skip polish.** Add no tests, error handling beyond what makes the prototype _runnable_, or abstractions. The goal is to learn quickly.
5. **Surface the state.** After every logic action or UI variant switch, print or render the full relevant state so the user can see the change.
6. **Capture the result.** Move each validated decision into the real code. Capture the prototype itself as a **primary source** by committing it to a throwaway branch outside main. Leave a context pointer to that branch on the implementation issue. Also capture the answer, including the verdict and the question it settled, in the issue or a commit. Keep only the validated decision on the main branch.
