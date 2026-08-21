---
name: writing-shape
description: Writing, exploit — shape raw material into an article, paragraph by paragraph.
disable-model-invocation: true
---

<what-to-do>

The user provides a Markdown file of raw material. Treat it as the input: fragments, unstructured prose, or a transcript. The format does not matter. Read the complete file before doing anything else.

Run a shaping session that produces a separate article document. This is **exploit**: exploration is complete and the input is fixed. Choose a structure and use the input to fill it. Do not edit the raw material file. This skill treats it as read-only.

If the user did not provide an article path, ask once and remember it.

</what-to-do>

<supporting-info>

## The loop

1. **Read the pile.** Read the complete input file and identify its contents.
2. **Establish the prerequisites.** Ask the user what the reader already knows. These concepts are **grounded** from the start. Ground every other concept in a block before a later block uses it. See [Grounding](#grounding).
3. **Draft 2–3 candidate openings.** Give each opening a different thesis or angle. Show all openings. Ask the user to choose one or compose a hybrid. The selected opening defines the article's work.
4. **Grow paragraph by paragraph.** After the opening is selected, ask "given this opening, what does the reader need to hear next?" Pull material from the pile. The next block can use only grounded concepts and must ground new concepts as needed. Discuss the block format: paragraph, list, table, callout, quote, or code block. Make each format choice deliberate and defensible.
5. **Append to the article file as you go.** Do not batch writes. Write each agreed paragraph or block immediately so the user can review the article.
6. **Repeat step 4 until the article is complete.** The user decides when it is complete.

## Grounding

Every **concept** must be **grounded** before a block can use it. The reader either knows it at the start or meets it in an earlier block. A block that uses an ungrounded concept can lose the reader. The unit is the concept, not its word. A block can use an idea the reader lacks even without jargon. When a concept has a name, a **term**, ground the idea and term together.

Ground a concept in one of two ways:

- **Prerequisite** — ground it before the opening. The reader brings it. Set it at the start.
- **Introduced** — establish it in a block. It remains grounded for the rest of the article.

Keep a list of grounded concepts. When you ask "what does the reader need to hear next?", check whether the next block needs an ungrounded concept. If it does, ground that concept first in the current or an earlier block. This is the gap-naming step in [Pulling from the pile](#pulling-from-the-pile): the pile lacks material there, while the article lacks a foundation here.

Choose what is a prerequisite and what to ground inside the article. Too many prerequisites exclude readers. Too many definitions make the opening difficult to read. Settle this choice with the user when establishing prerequisites.

## Conversational feel

This is an inverted grilling session. In ideation, the question was "what are you actually noticing?" Here it is "what is this article arguing, and in what order must the reader hear it?" Challenge weak transitions. Cut a paragraph that does not earn its place.

Specific moves to keep using:

- "What does this paragraph do for the reader that the previous one didn't?"
- "If I cut this, what breaks?"
- "Is this prose, or should it be a list? Why prose?"
- "This sentence is doing two jobs — split it or pick one."
- "The opening promised X. We've drifted to Y. Either re-thread it or change the opening."

## Pulling from the pile

Treat the raw material as source material, not a script. Select a fragment, adapt it to the surrounding paragraph, and place it. Split, merge, or paraphrase fragments as needed. The article must read as one voice.

If the pile lacks material that the article needs, state the gap: "We need an example here and the pile doesn't have one — give me one now or we cut this section."

## Format arguments to actually have

When choosing a block format, discuss these trade-offs with the user:

- **Prose vs. list.** Prose carries argument; lists carry parallel items. If items aren't truly parallel, prose is better. If they are, a list is faster to scan.
- **Inline vs. callout.** Tips, warnings, and asides go in callouts (`> [!TIP]`, `> [!NOTE]`) — but only if they'd genuinely derail the main argument inline. Otherwise leave them inline.
- **Table vs. repeated structure.** If the same shape repeats 3+ times with the same fields, a table. Otherwise prose with bold leads.
- **Quote vs. paraphrase.** Quote when the original wording is the point. Paraphrase when only the idea matters.
- **Code block vs. inline code.** Multi-line, runnable, or illustrative → block. Single token or identifier → inline.

## Writing rhythm

Append each agreed block to the article file. Reread the file from disk before every write because the user may have edited it. Never overwrite blindly. If the user requests a rewrite, edit only that paragraph and leave the rest unchanged.

## Out of scope

- Mining for fragments not in the pile. Handle gaps as described in "Pulling from the pile".
- Editing the raw material file.
- Publishing, formatting for a specific platform, or adding frontmatter without a user request.

</supporting-info>
