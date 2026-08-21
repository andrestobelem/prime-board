# Phase boundaries

A **phase** is one unit of work in a session, such as grilling, implementation, or QA. Use a practical boundary: a phase ends when that unit of work is complete.

The **phase boundary** is the point between two phases. Make this context decision only at that point. During a phase, continue the work or split the remaining work into subagents. Do not compact during a phase because the agent can lose context.

## The five options

| Option       | What it does                                                    |
| ------------ | --------------------------------------------------------------- |
| **Continue** | Stay in the session. No context switch at all.                    |
| **`/clear`** | Empty the context window and start from nothing.                  |
| **`/handoff`** | Write a portable markdown file and seed a session anywhere with it. |
| **Subagent** | Send the task to its own context window and get a report back.     |
| **`/compact`** | Compress this context and seed a fresh session with the summary.  |

## The tree

At the boundary, evaluate the options from top to bottom. Choose the first option whose answer is **yes**.

**1. Can you continue in this session?** Answer yes when either condition is true: the next phase needs this phase as a **primary source**, or the remaining [smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone) (~150k tokens) can hold the next phase. Grilling → implementation is the standard yes because implementation needs the reasoning verbatim, not as a summary. Continuing avoids a context switch, so evaluate it first.

**2. Is the context irrelevant to what comes next?** Decide whether all session content — exploration, decisions, and dead ends — can be discarded. If yes, use **`/clear`**. It returns the full context window without a context summary. `/clear` is not terminal; the old session remains resumable.

This decision is not reversible. If you clear *relevant* context, you lose the reasons behind the work. Reading the diff later cannot restore those reasons.

**3. Do you need to hand off?** Use `/handoff` only for these cases:

- swapping to a **new harness** (Claude → Codex),
- moving to a **new directory** or repo,
- sending the work to a **colleague**,
- or forking a side task you found **mid-phase** without derailing what you're doing.

This list is complete. `/handoff` provides **portability** through a file that can move between sessions. If no content must move, do not use it.

**4. Can the task be done AFK?** Decide whether the task has a narrow scope and can run without steering. If yes, send it to a **subagent** and leave this session unchanged. Automated review is a standard case: the agent reads the diff and reports while you are away.

**5. Otherwise, use `/compact`.** Use it when the context is relevant, the harness and directory stay the same, and you must remain involved. Pass an instruction (`/compact we're going to QA this area`) so the summary retains what the next phase needs.

`/compact` is the **default, not the first option**. It is last because the four options above are cheaper or more precise. Using it first can create a fresh session with an incorrect understanding of a decision that the summary simplified.

## Primary and secondary sources

Every option except **Continue** changes the session from a **primary source** to a **secondary source**. The session is replaced by a summary. The trade-off is:

| Source                            | Information | Noise | Room to move |
| --------------------------------- | ----------- | ----- | ------------ |
| Primary (Continue)                | Full        | Lots  | Little       |
| Secondary (`/compact`, `/handoff`) | Lossy       | Less  | Lots         |

This is why question 1 comes first. Accept information loss only when continuing costs more than it saves.

## These are judgement calls

These questions require judgment. The same boundary can produce different choices on different days. Always ask the questions **in order** and make the choice at the boundary, not during the phase.
