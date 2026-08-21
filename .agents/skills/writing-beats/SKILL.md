---
name: writing-beats
description: Writing, exploit — assemble raw material into a journey of beats, grounding each term before a beat leans on it.
disable-model-invocation: true
---

<what-to-do>

The user provides a Markdown file of raw material. This is **exploit**: exploration is complete and the input is fixed. Choose a path through it and use the material to fill each beat.

If the user did not provide an article path, ask once and remember it.

Run the article as a beat-by-beat journey. Let the user choose the path:

1. **Establish the prerequisites.** Before any beat, ask what the audience already knows. These concepts are **grounded** from the start. Ground every other concept in a beat before a later beat uses it. See [Grounding](#grounding).
2. Write 2–3 candidate **starting beats** from the raw material. Each is a different entry point. Each can use only grounded concepts. State which new concepts each beat grounds. Show the beats before writing to the article file. The user chooses one. Preview the beats that choice makes available.
3. After the user chooses a starting beat, write **only that beat** to the article file. A beat can be one sentence or several paragraphs. Stop after writing it.
4. Reread the article file from disk. Offer 2–3 candidate **next beats** that take the journey in different directions. Each must be reachable from the current grounded set. State which concepts each beat grounds.
5. Repeat steps 3–5 until the article reaches a natural end.

</what-to-do>

<supporting-info>

## Grounding

Every **concept** must be **grounded** before a beat can use it. The audience either knows it at the start or meets it in an earlier beat. A beat that uses an ungrounded concept can lose the reader. The journey cannot make that move. The unit is the concept, not its word. A beat can use an idea the reader lacks even without jargon. When a concept has a name, a **term**, ground the idea and term together.

Ground a concept in one of two ways:

- **Prerequisite** — ground it before the first beat. The audience brings it. Set it at the start.
- **Introduced** — establish it in a beat. It remains grounded for every later beat.

Each beat has two jobs: it **requires** already grounded concepts and **grounds** new concepts. Keep a list of grounded concepts and update it after each beat.

This rule shapes the user-selected path. A candidate beat is reachable only when all required concepts are grounded. A beat that grounds concept X enables every beat that requires X. When offering next beats, include only reachable beats and state what each beat grounds so the user can see which paths it enables.

Choose what is a prerequisite and what to ground inside the article. Too many prerequisites exclude readers. Too many definitions make early beats difficult to read. Settle this with the user when establishing prerequisites. Revisit it when a candidate beat requires an ungrounded concept. Add a grounding beat or promote the concept to a prerequisite.

## What is a beat

A beat is one move in the journey. It performs one action: set a scene, land a point, ask a question, add an aside, or change the angle. Then stop. Leave the reader at a point where the next beat can change direction.

Size a beat according to its needs:

- A single sentence if that's all the move is ("And then nothing happened for three weeks.").
- A short paragraph if the move needs setup.
- Multiple paragraphs if the beat is a self-contained vignette, argument, or example.

If a "beat" needs five paragraphs and three subheadings, it is not one beat. It is two beats joined together. Split it.

## Pulling from the pile

Pull material from the raw input for each beat. You can paraphrase, split, recombine, or quote. Treat the input as source material.

## Ending the journey

End the article when the journey is complete, not when the input is empty. Some fragments will remain unused. That is expected; extra raw material gives you options.

## Writing rhythm

- Append one beat at a time. Never write future beats early.
- Reread the article file from disk before every write. Preserve user edits.
- If the user substantially edits an earlier beat, use the edit to guide later beats.
- If the user says "rewrite that beat" or "go back and try a different beat 3", edit that beat in place and leave the rest unchanged.

</supporting-info>
