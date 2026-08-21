---
name: ask-matt
description: Ask which skill or flow fits your situation. A router over the skills in this repo.
disable-model-invocation: true
---

# Ask Matt

You do not need to remember every skill. Ask this router.

A **flow** is a path through skills. Most paths use one **main flow**, and two **on-ramps** join that flow. The remaining skills are standalone or provide vocabulary below the flow.

## The main flow: idea → ship

Use this route when you have an idea and want to build it.

1. **`/grill-with-docs`** — sharpen the idea through an interview. Start here when you are **working in a working directory**. This skill is stateful and records its findings in `CONTEXT.md` and ADRs. Without a working directory, use `/grill-me` (see Standalone). Both use the `/grilling` primitive. `grill-with-docs` also records the discussion in the repository.
2. **Branch — can you settle every question in conversation?** If a question needs a runnable answer (state, business logic, or a UI you must see), use a prototype. Bridge to and from the prototype with **`/handoff`**. A prototype has its own directory, which is the use case for `/handoff` (see Phase boundaries):
   - **`/handoff`** out, then open a fresh session against that file,
   - **`/prototype`** to answer the question with throwaway code,
   - **`/handoff`** back what you learned, and reference it from the original idea thread.
3. **Branch — is this a multi-session build?**
   - **Yes** → **`/to-spec`** (turn the thread into a spec), then **`/to-tickets`** to split it into tracer-bullet tickets. Each ticket declares its **blocking edges**. On a local tracker, store one file per ticket under `.scratch/<feature>/issues/` and work blockers first. On a real tracker, use native blocking links. Start **`/implement`** for each ticket whose blockers are complete, and **`/clear`** context between tickets. Each ticket is self-contained.
   - **No** → Run **`/implement`** in this same context window.

   In both cases, **`/implement`** builds each issue through **`/tdd`** internally, one red-green slice at a time. It then runs **`/code-review`**, a two-axis (Standards + Spec) review of the diff, before committing. Use **`/tdd`** alone when you want to build one behavior test-first without a full spec. Use **`/code-review`** alone to review a branch or PR against a fixed point.

### Context hygiene

Keep steps 1–3 in **one unbroken context window**. Do not compact or clear until after `/to-tickets`. This lets the grilling, spec, and tickets use the same reasoning. Each `/implement` then starts fresh from its ticket.

The limit is the **[smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone)**: the window (~150k tokens on state-of-the-art models) in which the model reasons sharply. If the session approaches this limit before `/to-tickets`, do not continue with degraded reasoning. Use `/compact` at the nearest phase boundary and continue (see Phase boundaries).

## On-ramps

Use an on-ramp when a starting situation generates work and then joins the main flow.

- **Bugs and requests piling up** → **`/triage`**. It moves issues through triage roles and produces agent-ready issues for **`/implement`**.

  Use triage only for issues **you did not create**: bug reports, incoming feature requests, and other raw requests. Tickets produced by `/to-tickets` are already agent-ready. **Do not triage them.**

- **Something is broken** → **`/diagnosing-bugs`**. Use it for hard bugs: bugs that resist a first review, intermittent failures, and regressions between two known-good states. It first creates a **tight feedback loop**: one command that already goes red on *this* bug. It then fixes the bug with a regression test. Its post-mortem points to **`/improve-codebase-architecture`** when the finding is that no suitable seam exists.

- **A large effort that does not fit in one session, such as a greenfield project or a large feature** → **`/wayfinder`**. When the path to the destination is not visible, it creates a **shared map** of **decision tickets** on the issue tracker and resolves them one at a time. It produces **decisions, not deliverables**, until the path is clear. Use **`/grill-with-docs`** for an idea that fits in one session. Use wayfinder only for the larger case.

  When the map is clear, **it hands off; it does not build**. Join the main flow at **`/to-spec`**. That skill turns the map's linked decisions into a buildable plan. Then use `/to-tickets` and `/implement` as usual. Do not send the map directly to `/implement`, because that skips the plan and loses linked detail. Use `/implement` directly only when the effort is genuinely small.

## Codebase health

Use this section for codebase upkeep, not feature work.

- **`/improve-codebase-architecture`** — run when you have time for codebase upkeep. It surfaces **deepening opportunities**. Selecting one _generates an idea_ for the main flow at `/grill-with-docs`. It finds candidates; use **`/codebase-design`** (below) to design the selected opportunity.

## Vocabulary underneath

Two model-invoked references provide vocabulary for the other skills. Each is the single source of truth for its terms. Use them directly when the **words**, not the process, are the problem. The skills above can also invoke them.

- **`/domain-modeling`** — sharpen the project's *domain* language. Challenge a vague term, resolve an overloaded word ("account" doing three jobs), and record a hard-to-reverse decision as an ADR. `/grill-with-docs` uses this discipline to keep `CONTEXT.md` a precise glossary.
- **`/codebase-design`** — the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) for designing a module's *shape*: substantial behavior behind a small interface at a clean seam. `/tdd` and `/improve-codebase-architecture` use this vocabulary.

## Phase boundaries

A **phase** is one unit of work in a session, such as grilling, implementation, or QA. At the **boundary** between phases, choose one of five options. This choice requires judgment:

- **Continue** — stay in the current session. This preserves the full context.
- **`/clear`** — empty the window when no current context matters to the next phase.
- **`/handoff`** — write a portable Markdown file. Use it only for a **new harness**, **new directory**, **colleague**, or side task forked **mid-phase**.
- **Subagent** — send a tightly scoped task to its own window and receive a report.
- **`/compact`** — summarize this context and start a fresh session. This is the **default**, but the last option in the tree.

Read [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md) for the ordered tree, the five questions, and the reason for each branch. It explains why the cost of losing the primary source makes **Continue** the first option to evaluate. Make the choice **at** a boundary. During a phase, continue or split the remaining work into subagents.

## Standalone

These skills are outside the main flow.

- **`/grill-me`** — the same interview as `/grill-with-docs`, but **stateless**: it saves nothing locally and creates no `CONTEXT.md`. Use it when you are **not working in a working directory**, for example when sharpening a plan, design, or document without a repository. In a working directory, use `/grill-with-docs` to record the discussion.
- **`/grilling`** — the interview primitive: rounds, the frontier, facts owned by the agent, and decisions owned by the user. `/grill-me` and `/grill-with-docs` are its named entry points. `/triage`, `/wayfinder`, and `/improve-codebase-architecture` use it internally. Use it directly when you need the interview without a wrapper.
- **`/resolving-merge-conflicts`** — resolve an in-progress merge or rebase conflict hunk by hunk. Trace **intent** to each side's primary source instead of choosing lines. Finish the operation. It never runs `--abort`. Use it only when you are already in a conflict.
- **`/prototype`** — a small, throwaway program that answers one design question: whether a state model feels right or what a UI should look like. Throwaway describes the code constraint; it does not require deletion. Move the answer into the real code. Keep the prototype as a **primary source** on a `prototype/<name>` branch outside main, and point to it from the implementation issue. Use it as the step 2 detour or whenever a design question is difficult to settle on paper.
- **`/research`** — delegate reading to a **background agent**. It investigates a question against **primary sources** and writes a cited Markdown file in the repository. Continue working while it reads. Use the file in the main flow at `/grill-with-docs`. Research supports the reasoning; it does not replace it.
- **`/to-questionnaire`** — use when the required information belongs to **someone else**, not the user or codebase. It writes a questionnaire for that person. It is the inverse of `/grill-me`: it interviews the user about the **send** (recipient and required response), then targets the gap. Use the response in `/grill-with-docs` or `/to-spec`.
- **`/wizard`** — use for steps only a **human** can take: provisioning infrastructure, setting up credentials or CI secrets, using an unfamiliar third-party dashboard, or running a one-off migration or cutover. It generates an interactive bash script that opens each URL, captures each value, and writes it into `.env` and GitHub secrets. Model invocation lets the agent use it when it reaches a step only the human can complete. If the agent can do the step itself, do it instead.
- **`/wait-what`** — use when a message was not clear. Use it mid-conversation or inside another skill. It restates the message with the missing context, in plain English, using `CONTEXT.md` vocabulary. `/grill-with-docs` is the earlier alternative: agree on shared language before jargon appears.
- **`/teach`** — learn a concept across multiple sessions, using the current directory as a stateful workspace.
- **`/writing-for-agents`** — reference for writing documents consumed by agents: skills, AGENTS.md, and referenced documents.

## Precondition

**`/setup-matt-pocock-skills`** — run this before your first engineering flow. It configures the issue tracker, triage labels, and document layout required by the other skills. Custom issue trackers also work.
