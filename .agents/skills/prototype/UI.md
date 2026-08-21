# UI Prototype

Generate **several radically different UI variations** on one route. Let the user switch between variants with a floating bottom bar. The user selects one variant, combines useful parts if needed, and discards the rest.

Use [LOGIC.md](LOGIC.md) when the question concerns logic or state rather than appearance.

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Two sub-shapes — strongly prefer sub-shape A

A UI prototype is easier to judge when it uses the rest of the app: the real header, sidebar, data, and density. A separate throwaway route hides problems that appear in the application context. Use sub-shape A whenever an existing page can host the variants. Use sub-shape B only when the prototype has no suitable existing page.

### Sub-shape A — adjustment to an existing page (preferred)

The route already exists. Render variants **on the same route**, selected by a `?variant=` URL search param. Keep the existing data fetching, params, and auth. Change only the rendered subtree. Use this shape by default unless a specific reason prevents it.

If the prototype has no page but *would naturally live inside one* (a new dashboard section, settings card, or step in an existing flow), use sub-shape A. Mount the variants in the host page.

### Sub-shape B — a new page (last resort)

Use this only when the prototype has no existing page, such as a new top-level surface or a flow that cannot be embedded.

Create a **throwaway route** that follows the project's routing convention. Do not create a new top-level structure. Name it as a prototype (for example, include `prototype` in the path or filename). Use the same `?variant=` pattern.

Before choosing sub-shape B, verify that no existing page can host the prototype. An empty route hides design problems that a populated page would expose.

In both sub-shapes the floating bottom bar is identical.

## Process

### 1. State the question and pick N

Use **3 variants** by default. More than 5 variants reduce meaningful differences and add noise. Use no more than 5.

Record the plan in one line at the prototype location or in a top-of-file comment:

> "Three variants of the settings page, switchable via `?variant=`, on the existing `/settings` route."

Use this plan whether or not the user is available to review it.

### 2. Generate radically different variants

Draft each variant. Check each variant against:

- The page's purpose and the data it has access to.
- The project's component library / styling system (TailwindCSS, shadcn, MUI, plain CSS, whatever).
- A clear exported component name, e.g. `VariantA`, `VariantB`, `VariantC`.

Variants must be **structurally different**. Change the layout, information hierarchy, and primary affordance, not only the colors. Three slightly changed card grids are not a UI prototype. If two drafts are too similar, redo one with explicit "do not use a card grid" guidance.

### 3. Wire them together

Create a single switcher component on the route:

```tsx
// pseudo-code — adapt to the project's framework
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A','B','C']} current={variant} />
  </>
);
```

For sub-shape A (existing page), keep all existing data fetching above the switcher. Change only the rendered subtree for each variant.

For sub-shape B (new page), mount the same switcher in the throwaway route under `/prototype/<name>`.

### 4. Build the floating switcher

Use a small fixed-position bar at the bottom center of the screen with three pieces:

- **Left arrow** — selects the previous variant and wraps around.
- **Variant label** — shows the current variant key and, when the variant exports a name, that name too. For example, `B — Sidebar layout`.
- **Right arrow** — selects the next variant and wraps around.

Behaviour:

- Clicking an arrow updates the URL search param. Use the framework router — `router.replace` on Next, `navigate` on React Router, etc. This makes the variant shareable and stable after reload.
- Keyboard: `←` and `→` arrow keys also cycle. Do not intercept arrow keys when an `<input>`, `<textarea>`, or `[contenteditable]` is focused.
- Make the bar visually distinct from the page, for example with a high-contrast pill or subtle shadow. It must not look like part of the evaluated design.
- Hide the bar in production builds. Gate it with `process.env.NODE_ENV !== 'production'` or an equivalent check so a prototype merge cannot ship it to users.

Put the switcher in one shared component so both sub-shapes can reuse it. Place it where the project keeps shared UI.

### 5. Hand it over

Provide the URL and the `?variant=` keys. The user can review the variants later. The key feedback is often **"I want the header from B with the sidebar from C"**. That combination identifies the desired design.

### 6. Capture the answer and clean up

After a variant wins, capture the answer — the selected variant and the reason — as described in [SKILL](SKILL.md). Move the winner into the real code. Move the remaining variants to the throwaway branch, not main:

- **Sub-shape A** — move the winner into the existing page. Remove the losing variants and switcher from main.
- **Sub-shape B** — promote the winner to a real route. Remove the throwaway route and switcher from main.

The full set of variants is the primary source. Keep it on the throwaway branch. Variant components and the switcher left in main become stale and confuse future readers.

## Anti-patterns

- **Variants that differ only in color or copy.** That is a tweak, not a prototype. Real variants must differ in structure.
- **Sharing too much code between variants.** A shared `<Header>` is acceptable. A shared `<Layout>` defeats the purpose. Each variant must be able to replace the layout.
- **Connecting variants to real mutations.** Read-only prototypes are acceptable. If a variant needs to mutate, point it at a stub. The question is "what should this look like", not "does the backend work".
- **Promoting the prototype directly to production.** Variant code uses prototype constraints (no tests and minimal error handling). Rewrite it before moving it into production.
