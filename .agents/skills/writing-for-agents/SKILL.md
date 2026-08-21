---
name: writing-for-agents
description: Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md.
---

Use this reference when writing any document an agent consumes: a skill, an `AGENTS.md` or `CLAUDE.md`, or a document reached by a pointer. Packaging differs, but the writing rules are the same. Use the same controls to make each run predictable. The goal is a consistent _process_, not a fixed output.

When the document you're writing is a skill, read [`SKILL-MECHANICS.md`](SKILL-MECHANICS.md) for frontmatter, invocation choice, and router skills.

## Context pointers

A **context pointer** is a reference in the agent's context. It names material outside the current context and states when to read that material. A skill's description is a context pointer. A line in `AGENTS.md` that names a document is also a context pointer. The pointer's _wording_, not its target, determines when and how reliably the agent reads the material. If a required target has a weak pointer, first sharpen the pointer. Inline the material only if a sharper pointer is not sufficient.

A pointer has two jobs: state what the material contains and list the **branches** that trigger it. A branch is a distinct case handled by the document. Different runs can take different paths through those branches. Every word in an always-loaded pointer uses context on every turn, so prune pointers more strictly than the body:

- **Front-load the leading word** — the pointer performs its trigger function here.
- **One trigger per branch.** Synonyms for one branch repeat the same branch. Collapse them and keep only distinct branches.
- **Remove identity the body already provides.**

## The two loads

Every document and pointer uses one of two budgets:

- **Context load** — the cost of material that remains in the agent's window: an `AGENTS.md` line, a skill description, or any material present on every turn. This material uses tokens and attention whether or not it fires.
- **Cognitive load** — the cost to the human of knowing which documents exist and when to use them. The human is the index. This cost supports human agency. Spend it where human judgment matters and remove it where it does not.

Material reached only through a pointer avoids context load but uses the pointer's line. Material with no pointer uses only cognitive load.

## Information hierarchy

A document contains two content types: **steps** (the ordered actions the agent performs) and **reference** (definitions, rules, and facts consulted on demand). A document can contain steps, reference, or both. Place each item in the **information hierarchy**, ordered by how soon the agent needs it:

1. **In-file step** — the primary level: the ordered actions the agent performs.
2. **In-file reference** — material the agent consults on demand. A flat peer set, such as every rule in a review, is valid.
3. **Disclosed reference** — material in a separate file. A context pointer reaches it and the agent loads it only when the pointer fires. The file can be a sibling or any external reference that documents can point to.

Disclose too little and the top becomes long. Disclose too much and you hide material the agent needs. Choose the level that balances these risks.

**Progressive disclosure** moves material out of the main file and behind a pointer. This keeps the top level clear and protects the information hierarchy. Use branching as the disclosure test: keep material in the file when every branch needs it; use a pointer when only some branches need it. When a document has steps, disclose reference that would otherwise hide those steps. This reduces execution variance as well as improving readability.

**Co-location** decides what belongs together at one information level. Keep a concept's definition, rules, and caveats under one heading instead of scattering them. Reading one part then exposes its related parts. Test this by reading the document as an agent would. Grouped material supports that reading; scattered material does not. Co-location differs from duplication: duplication repeats one meaning, while scattering splits one meaning across locations.

**Sprawl** occurs when a document is too long, even when every line is current and unique. Excess length reduces attention and makes relevance harder to maintain. Disclose reference behind pointers. Split by branch or sequence so each path carries only the material it needs.

## Steps and completion criteria

End every step with a **completion criterion**. The criterion states when the work is complete. It has two important properties:

- **Clarity** — the agent can distinguish complete from incomplete. A vague bound ("understanding reached") causes **premature completion**. The agent may stop before the step is complete. Later visible steps, the **post-completion steps**, can increase this risk. First **sharpen the bound** (a local and low-cost change). If the bound remains unclear and the agent still stops early, split the sequence to hide later steps. This works only across a real context boundary, such as a hand-off or subagent dispatch. An inline call leaves later steps in context.
- **Demand** — the amount of work required. "Every modified model accounted for" requires more work than "produce a change list". Demand drives **legwork**, the investigation required by the task even when it is not a separate step. Demand also applies to reference: "every rule applied" requires exhaustive coverage in the same way that "every step done" requires an exhaustive sequence.

Use criteria that are both checkable and exhaustive.

## When to split

Splitting one document into two uses one of the two loads. Split only when the split provides a clear benefit:

- **By sequence** — split a sequence when visible later steps cause the agent to rush the current step. Hiding later steps can increase the legwork on the current task. Do not merge sequences when doing so would expose later steps and cause premature completion.
- **By invocation** — this is specific to skills. See [`SKILL-MECHANICS.md`](SKILL-MECHANICS.md).

## Leading words

A **leading word** is a compact concept that the model already knows and can use while it runs a document (_lesson_, _fog of war_, _tracer bullets_). Repeat the word as a token, not as a full sentence. Repetition builds a shared meaning and anchors related behavior with few tokens. You can create a new leading word if you define it clearly. Prefer an existing word when it expresses the concept.

A leading word has two effects. In the body, it guides _execution_: the agent uses the same behavior each time it appears and focuses on the related class in flat reference. In a pointer, it guides _invocation_: when the word appears in prompts, documents, and code, the agent links the shared language to the referenced material.

Look for places where a leading word can replace repeated wording. A triad repeated in three places or a pointer that uses a full sentence for one idea can often become one token:

- "fast, deterministic, low-overhead" → _tight_ (a _tight_ loop).
- "a loop you believe in" → _red_ — a fuzzy gate becomes a binary observable state (the loop goes _red_ on the bug, or it doesn't).

This reduces token use and gives the agent a stronger concept to use. Check every document for repeated meanings that a leading word can replace.

**Negation** is a failure mode of this technique. A prohibition can bring the forbidden behavior into context and make it more available. _Don't think of an elephant_ illustrates this effect. The negation is a weak modifier, so the activated concept remains prominent. Prompt the **positive** behavior instead. State the target behavior ("write one-line comments") so the forbidden behavior does not appear. Keep a prohibition only when you cannot state the guardrail positively. In that case, pair it with the positive target.

## Pruning

- Keep each meaning in a **single source of truth**. One authoritative location makes a behavior change a one-place edit. **Duplication** repeats one meaning in multiple locations. It increases maintenance and token use. It can also give the meaning more prominence than its information level requires. A leading word is different: it repeats a token intentionally, not the meaning.
- The **environment** is also a source of truth: `package.json` scripts, config files, the directory layout, and `--help` output. A document that repeats this information is a **cache**. Use a cache only when the lookup is expensive. Document conventions, reasons, and gotchas that the agent cannot discover by inspection. Leave one-file, one-command lookups in the environment so they do not become stale.
- Check every line for **relevance**. Each line must support the document's purpose. Remove exposition and disclose branches that do not apply to every run. Remove stale behavior and facts. Short documents are easier to keep current. Without pruning, stale content accumulates until current content is difficult to find.
- Check for **no-ops** sentence by sentence. An instruction the model already follows by default adds no value. Ask whether the sentence changes behavior. Resolve disagreements by running the document, not by debate. When a sentence fails this test, delete the sentence instead of shortening it. Apply the same test to leading words: a weak word that does not change the default (_be thorough_ when the agent is already thorough-ish) is a no-op. Use a stronger word (_relentless_) or remove the instruction.
