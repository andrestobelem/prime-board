# HTML Report Format

Render the architectural review as one self-contained HTML file in the OS temporary directory. Load Tailwind and Mermaid from CDNs. Use Mermaid for graph-shaped diagrams. Use hand-built divs and inline SVG for editorial visuals such as mass diagrams and cross-sections. Use both approaches. Do not use Mermaid for every diagram.

## Scaffold

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
    </script>
    <style>
      /* small custom layer for things Tailwind doesn't cover cleanly:
         dashed seam lines, hand-drawn-feeling arrow heads, etc. */
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## Header

Show the repository name, date, and a compact legend: solid box = module, dashed line = seam, red arrow = leakage, thick dark box = deep module. Do not add an introduction paragraph. Start with the candidates.

## Candidate card

Let the diagrams carry the information. Keep prose sparse and plain. Use glossary terms from `/codebase-design` directly.

Each candidate is one `<article>`:

- **Title** — short and names the deepening (for example, "Collapse the Order intake pipeline").
- **Badge row** — recommendation strength (`Strong` = emerald, `Worth exploring` = amber, `Speculative` = slate), plus a tag for the dependency category (`in-process`, `local-substitutable`, `ports & adapters`, `mock`).
- **Files** — monospaced list, `font-mono text-sm`.
- **Before / After diagram** — the main element. Use two side-by-side columns. See the patterns below.
- **Problem** — one sentence. What hurts.
- **Solution** — one sentence. What changes.
- **Wins** — bullets, ≤6 words each. For example, "Tests hit one interface", "Pricing logic stops leaking", "Delete 4 shallow wrappers".
- **ADR callout** (if applicable) — one line in an amber-tinted box.

Do not add explanatory paragraphs. If a diagram needs a paragraph, redraw the diagram.

## Diagram patterns

Choose the pattern that fits each candidate. Mix patterns. Do not make every diagram identical.

### Mermaid graph (the workhorse for dependencies / call flow)

Use a Mermaid `flowchart` or `graph` when the point is "X calls Y calls Z, and look at the mess." Put it in a Tailwind-styled card. Use classDef to color leakage edges red and the deep module dark. Use sequence diagrams for "before: 6 round-trips; after: 1."

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### Hand-built boxes-and-arrows (when Mermaid's layout is unsuitable)

Render modules as `<div>` elements with borders and labels. Render arrows as inline SVG `<line>` or `<path>` elements positioned over a relative container. Use this pattern when the "after" diagram must show one thick-bordered deep module with faded internals. Mermaid cannot provide that visual weight.

### Cross-section (good for layered shallowness)

Stack horizontal bands (`h-12 border-l-4`) to show the layers a call crosses. Before: 6 thin layers with no meaningful work. After: 1 thick band labeled with the consolidated responsibility.

### Mass diagram (good for "interface as wide as implementation")

Use two rectangles per module: one for interface surface area and one for implementation. Before: the interface rectangle is nearly as tall as the implementation rectangle (shallow). After: the interface rectangle is short and the implementation rectangle is tall (deep).

### Call-graph collapse

Before: render a function-call tree as nested boxes. After: collapse the tree into one box and show the now-internal calls faded inside it.

## Style guidance

- Use an editorial style, not a corporate dashboard. Use generous whitespace. Serif headings are optional (`font-serif` works well with stone/slate).
- Use color sparingly: one accent (emerald or indigo), red for leakage, and amber for warnings.
- Keep diagrams about 320px tall so before/after diagrams fit side by side without scrolling.
- Use `text-xs uppercase tracking-wider` for module labels inside diagrams. They must look schematic, not like UI.
- Use only the Tailwind CDN and Mermaid ESM import as scripts. Keep the report static. Add no app code or interactivity beyond Mermaid rendering.

## Top recommendation section

Use one larger card with the candidate name, one sentence explaining why, and an anchor link to its card.

## Tone

Use concise plain English. Take architectural nouns and verbs from `/codebase-design`. Do not replace them for brevity.

**Use exactly:** module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality.

**Never substitute:** component, service, unit (for module) · API, signature (for interface) · boundary (for seam) · layer, wrapper (for module, when you mean module).

**Phrasings that fit the style:**

- "Order intake module is shallow — interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

**Wins bullets** state gains with glossary terms: *"locality: bugs concentrate in one module"*, *"leverage: one interface, N call sites"*, *"interface shrinks; implementation absorbs the wrappers"*. Do not write *"easier to maintain"* or *"cleaner code"*. Those terms are not in the glossary.

Do not hedge or add introductory filler such as "it's worth noting that…". Convert a sentence to a bullet when appropriate. Remove bullets that add no value. Use a term from the `/codebase-design` glossary before creating a new term.
