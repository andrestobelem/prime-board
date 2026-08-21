---
name: writing-fragments
description: Writing, explore — mine raw fragments, no structure yet.
disable-model-invocation: true
---

<what-to-do>

This skill performs only **explore**. Expand possible content without choosing a structure. Choosing a structure is _exploit_ and belongs to another skill. Run a grilling session that produces fragments. Interview the user about the subject they want to write about. Do not impose phases, outlines, or article structure.

As either participant produces fragments, append them to one Markdown file.

If the user did not provide a path, ask once where to save the document. Remember the path for the rest of the session.

Capture fragments from the user's first message, including the initial prompt.

On the first write, add one H1 with a working title. The title can change later. Add nothing else: no metadata, TOC, or date.

</what-to-do>

<supporting-info>

## What is a fragment

A fragment is text that might remain in the final article. It must be _readable by the author_, who can tell what it means. It does not need to define its terms or make sense to a new reader. Evaluate it as writing, not as a complete argument.

Fragments can have different forms. Examples include:

- A sharp sentence you'd want to deploy somewhere but don't yet know where.
- A claim with a one-line justification.
- A vignette: a thing that happened, a code snippet, a scenario, an analogy.
- A half-thought: "something about how X feels like Y, work this out later."
- A quote, a piece of dialogue, an overheard line.
- A list of related observations that hang together by feel.
- A complaint, a confession, a punchline.
- A **leading word** — a compact metaphor or coinage the whole piece can hang on (one term that names the idea, the way _tracer bullets_ or _fog of war_ names a whole pattern).

A leading word is the most valuable fragment. It is load-bearing: the right word can shape the later structure, transitions, and title. When the conversation returns to one idea, try to create a word for it.

Use a novelist's diary as the model: collect unstructured observations that can later provide raw material. Fragments are observations.

## File format

```markdown
# Working title

A first fragment lives here.

It can be multiple paragraphs. It can include lists, code, quotes — whatever
shape the fragment naturally takes.

---

A second fragment.

---

> A quoted line that the user wants to keep around.

A reaction to it.

---

- A cluster of related observations
- That hang together by feel
- And want to be near each other
```

Separate fragments with a horizontal rule (`\n---\n`). Do not use headings inside the body or tags. Keep fragments in the order added.

## Writing rhythm

Append without asking permission for each fragment. Mention the addition in passing ("adding that"). Do not interrupt the conversation with save dialogs.

Before every write, reread the file from disk. The user may have edited, reordered, or deleted fragments. Preserve those changes. Never overwrite the file. Append only, unless the user asks you to edit a specific fragment in place.

Treat "cut the last one", "rewrite that one sharper", and "merge those two" as first-class instructions at any time.

</supporting-info>
