# Logic Prototype

Build one self-contained HTML file: a **shareable demo** that lets anyone drive a state model with buttons. Use this branch for questions about **business logic, state transitions, or data shape**. These models can look correct on paper and fail when you exercise real cases.

The file has no dependencies to install. Give it to a non-developer, such as a designer, PM, or domain expert. Use domain language instead of code language so they can evaluate the model.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where someone wants to **press buttons and watch state change**.

If the question is "what should this look like" — wrong branch. Use [UI.md](UI.md).

## Process

### 1. State the question

Before writing code, record the state model and the question. Put one paragraph at the top of the demo in a visible introduction, not only in a comment. Make the question explicit so someone can verify it later, whether the user is watching now or returns to it while AFK.

### 2. Isolate the logic in a portable module

Put the logic that answers the question in one `<script>` block. Write it as a small, pure module that can move into the real codebase later. The surrounding page is throwaway; this module is not.

The right shape depends on the question:

- **A pure reducer** — `(state, action) => state`. Good when actions are discrete events and state is a single value.
- **A state machine** — explicit states and transitions. Good when "which actions are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no implicit current state — just transformations.
- **A class or module with a clear method surface** when the logic genuinely owns ongoing internal state.

Choose the shape that best fits the question, *not* the shape that is easiest to connect to a page. Keep the module pure: no DOM, no `document`, and no button handler that reaches inside it. The page calls the module; data does not flow from the module into the page. After the question is answered, move the validated reducer, machine, or function set into the real module.

### 3. Build the shareable HTML file

Use one file with plain HTML/CSS/JS. Use no framework, bundler, or server. Keep everything inline so the file opens by double-click and remains usable when shared. Anyone must be able to run it by opening it.

Write for a non-developer. Use **domain language** for every label, not code language. Buttons and state must describe the business, not the reducer. Explain the behavior in plain words.

Lay it out with a clean hierarchy, top to bottom:

1. **Title and one-line explanation** of what this demo lets you explore (the question from step 1).
2. **Current state** — the full relevant state, rendered as a readable panel (labelled fields, not a raw JSON dump), re-rendered after every click so the change is visible. Where it helps a non-developer follow, call out what just changed.
3. **Free-play buttons** — one button per action, always available, so anyone can poke at the model in any order. Each click dispatches its action and re-renders the state.
4. **Guided walkthroughs** — a set of **scenarios**, one per tab. Each tab holds a short plain-language description of the scenario — the situation it sets up and what to watch for — and underneath it, the ordered **buttons to press** for that scenario. Each step is a real button: clicking it performs that action and moves to the next step. Starting a walkthrough resets to a known initial state so the scenario runs the same way every time.

Choose scenarios that demonstrate difficult cases: the happy path, a tricky edge case, and an illegal action attempt. Focus on cases that are difficult to reason about on paper.

Keep the design clear and restrained: clean typography, generous spacing, and one accent color. Use no animations or decorative effects that compete with the state and buttons.

### 4. Hand it over

Send the file or open it for the user. The user can run the walkthroughs and free-play controls later. Pay attention when they say "wait, that shouldn't be possible" or "huh, I assumed X would be different". These statements identify problems in the _idea_. Add requested actions or scenarios. Prototypes can evolve.

### 5. Capture the answer and the prototype

After the prototype answers its question, capture the answer and the prototype as described in [SKILL](SKILL.md). For this logic branch, move the validated reducer, machine, or function set into the real module. Keep the HTML shell on the throwaway branch as a primary source. Its single-file form keeps it easy to run again.

## Anti-patterns

- **Keep tests out of the prototype.** A prototype that needs tests is no longer a prototype.
- **Keep the real database out of the prototype.** Use in-memory state unless the question is specifically about persistence.
- **Answer one question.** Do not add "what if we wanted to support X later" work.
- **Keep logic and page separate.** If the pure module references the DOM, `document`, or button handlers, it cannot move into the codebase. Keep the page as a thin shell over a pure module.
- **Keep frameworks, bundlers, and servers out of the prototype.** Use one file that the recipient can open directly. A React app or a development server does not provide a "shareable" prototype.
- **Keep the HTML shell out of production.** The page is optimized for manual exploration. Keep the logic module behind it.
