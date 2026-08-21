---
name: loop-me
description: Grill me about specs for the workflows I want to build, within this workspace.
disable-model-invocation: true
argument-hint: "A workflow to design, or nothing to go find one"
---

Run a stateful `/grilling` session. Produce only **workflow** specs. Use the grilling discipline: ask one round of questions at a time and include a recommended answer for each question. Focus on the vocabulary and goal below. Create, edit, or delete specs as the answers resolve them.

## The loop lens

A **loop** is a recurring pattern in the user's life: a career activity, a weekly activity, a morning activity, or one repeated task. Modeling a life as nested loops shows which activities are predictable and suitable for **delegation**. Use this lens to find loops worth specifying and to propose loops the user has not identified.

A **workflow** is the spec of one loop, made real. You run a workflow on a loop — the loop is its running instantiation. Workflows live in `workflows/*.md` and are the source of truth.

## Vocabulary

Use this shared language only when a workflow needs it. It is not a checklist. **Define no structure by default**: a workflow needs no AI, checkpoint, or schedule unless the grilling shows that it does.

- **Trigger** — what starts each run: an **event** (a new email, a new issue) or a **schedule** (every morning). An event trigger is usually more efficient.
- **Checkpoint** — a human-in-the-loop point where the user is asked to verify or decide. Some workflows have none and run autonomously; some use no AI at all.
- **Push right** — defer the checkpoint as far as possible. Do the maximum work before involving the human. Ask once, late, with everything prepared.
- **Brief** — what a checkpoint presents: a concise, decision-ready summary of what was produced and why, with a link to the asset. Never present the raw output. The user reads a brief, not a draft. Keep review fast.

## Definition of done

A workflow spec is complete when an implementer agent can build it without asking a question. Continue grilling until this condition is true.

## The workspace

- `workflows/*.md` — one spec per workflow.
- `NOTES.md` — raw notes about the user's world: the tools they use, the channels they process, and their terminology for both. If it is empty or incomplete, interview the user before specifying anything. Replace vague terms with canonical terms as they appear, and record them here.
