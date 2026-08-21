---
name: wayfinder
description: Plan a huge chunk of work — more than one agent session can hold — as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
---

Use this skill when an idea is too large for one agent session and the path to the **destination** is not yet clear. Wayfinding finds the path; it does not implement the destination. This skill creates a **shared map** on the repository's issue tracker and resolves its **decision tickets** one at a time. Each ticket resolves a decision, not an implementation slice.

The destination differs for each effort. Naming it is the first mapping step because it defines every ticket. The destination can be a spec to hand off and refine, a decision to lock before planning, or an in-place change such as a data-structure migration. The map is domain-agnostic and supports engineering work, course content, and other work with this shape.

## Plan, do not implement

Wayfinder is **planning** by default. Each ticket resolves a decision. The map is complete when the path is clear and no decision remains before implementation. If you want to implement the work, that usually means the map is complete and it is time to hand off. An effort can override this in its **Notes** and include execution. Without that override, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue with a **name** (its title). In all human-facing text, including narration and the map's Decisions-so-far, use that name. Do not use only an id, number, or slug. A list such as `#42, #43, #44` is difficult to read. Keep the id and URL inside the linked name, but do not use either as the name.

## The Map

The map is one issue on the repository's issue tracker, labeled `wayfinder:map`. It is the canonical artifact. Its tickets are child issues of the map.

The map is an **index**, not a store. It lists completed decisions and links to the tickets with details. Each decision has one source: its ticket. The map summarizes and links the decision; it does not repeat the full decision.

**The storage for the map, child tickets, blocking, and frontier queries is tracker-specific.** Use the provided issue tracker. If it is missing, tell the user to run `/setup-matt-pocock-skills`. Read the tracker document's "Wayfinding operations" section for this repository's implementation. If no tracker is provided, use the local-markdown tracker.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are open child issues, found by query.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is a **child issue** of the map. The tracker's issue id identifies it. The body contains the question and is sized for one 100K token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Give each ticket one `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task` (see [Ticket Types](#ticket-types)).

A session **claims** a ticket by assigning it to the developer driving the map **before** doing any work. Concurrent sessions then skip the ticket. The assignee is the claim. An open, unassigned ticket is unclaimed.

Use the tracker's **native** dependency relationship for blocking. Native links render the frontier _visually_ in the tracker's UI, so the human can see available work without opening the map. Use a body convention only when the tracker has no native blocking. A ticket is **unblocked** when every blocker is closed. The **frontier** consists of open, unblocked, unclaimed child tickets.

Do not put the answer in the ticket body. Record it when you resolve the ticket (see [Work through the map](#work-through-the-map)). Link assets created during resolution from the issue. Do not paste them into the issue.

## Ticket Types

Every ticket is either **HITL** (human in the loop) or **AFK** (agent-driven). A HITL ticket requires a live exchange with the human. The agent must not answer for the human. A grilling agent that answers its own questions violates this rule.

- **Research** (AFK): Read documentation, third-party APIs, or local resources such as knowledge bases to find a fact needed by a decision. Resolve it with a subagent that calls the Skill tool with "research". Use it when the required knowledge is outside the current working directory.
- **Prototype** (HITL): Create a cheap, rough, concrete artifact for discussion: an outline, rough design, stub, or UI/logic code. Call the Skill tool with "prototype" and link the prototype as an asset. Use it when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation. This is the default type. Always call the Skill tool twice, for "grilling" and "domain-modeling".
- **Task** (HITL or AFK): Complete manual work required before a _decision_ can be made. Nothing needs a decision, prototype, or research, but the discussion cannot continue until the work is complete. Examples include signing up for a service to evaluate its API, provisioning access, or moving data to inspect its shape. This type unblocks a decision; it does not deliver the destination. The agent performs it when possible (AFK). Otherwise, it gives the human a precise checklist (HITL). Resolve the ticket when the work is complete. Record what was done and any resulting facts (credential location, new URLs, row counts) that later tickets need.

## Fog of war

The map is _deliberately_ incomplete. Do not create tickets for questions you cannot yet state. Beyond the live tickets is the **fog of war**: decisions and investigations that depend on open questions and cannot yet be defined. Resolving a ticket clarifies the next questions. Create tickets for those questions one at a time until the path to the destination is clear and no tickets remain.

Use the map's **Not yet specified** section for this view. Record the suspected question or area to revisit. Everything in this section is in scope but not precise enough for a ticket. Record as much detail as available so collaborators understand the direction of the effort.

**Fog or ticket?** Decide whether you can state the question precisely now. Do _not_ use your ability to answer it as the test.

- **Ticket when** the question is precise, even if it is blocked and you cannot act on it yet.
- **Not yet specified when** you cannot state the question precisely. Do not split the fog into ticket-sized pieces. It is broader than a ticket. One part may become several tickets or no tickets when the frontier reaches it.

**Not yet specified** excludes decisions already recorded in Decisions so far, existing live tickets, and work listed in Out of scope.

## Out of scope

Fog contains only work that leads _toward_ the destination. The destination defines scope. Work beyond it is **out of scope**, not fog, and does not belong in **Not yet specified**. Put it in the map's **Out of scope** section. This section records work you intentionally excluded from _this_ effort. Scope, not question precision, determines this placement.

Out-of-scope work never becomes a ticket. The frontier stops at the destination. Consider this work again only when you define a new destination and start a new effort.

Ruling out work is a scoping action, not a route step. If an existing ticket is beyond the destination, **close it**. This can happen when charting included the ticket by mistake or when a resolution exposes the scope. A closed ticket is outside the frontier. Add one line to **Out of scope** with the gist, the reason, and a link to the closed ticket. Do not add it to **Decisions so far**, which records decisions on the route.

## Invocation

The skill has two modes. In both modes, **never resolve more than one ticket per session**, except for research tickets.

### Chart the map

The user invokes this mode with a loose idea.

1. **Name the destination.** Call the Skill tool twice, for "grilling" and "domain-modeling", to define what the map must reach: the spec, decision, or change. Settle the destination first because it defines the scope.
2. **Map the frontier.** Grill again, **breadth-first**. Cover the whole space instead of exploring one thread deeply. Surface open decisions and the first available steps. **If this surfaces no fog**, the path is clear and the effort fits in one session. A map is not needed. Stop and ask the user how to proceed.
3. **Create the map** (label `wayfinder:map`). Fill in Destination and Notes. Leave Decisions-so-far empty. Record the fog in **Not yet specified**.
4. **Create the tickets you can specify now** as child issues of the map. Wire blocking edges in a **second pass** because issues need ids before they can reference each other. Wiring separates the frontier from blocked tickets. Keep questions that you cannot yet specify in **Not yet specified**.
5. **Start the research subagents.** For each `research` ticket you created, start a subagent that calls the Skill tool with "research". Run them in parallel. Capture findings on a throwaway `research/<name>` branch with a context pointer from the ticket.
6. Stop. Charting is one session's work. Do not resolve tickets during charting.

### Work through the map

The user invokes this mode with a map (URL or number). A ticket is **optional**. Without one, you choose the next decision instead of the user.

1. Load the **map** summary, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise choose the first frontier ticket in order. **Claim it** by assigning it to yourself before any work.
3. Resolve it. **Zoom as needed**: fetch the full body of related or closed tickets on demand. Call the Skill tool for the skills named in `## Notes`. If uncertain, call the Skill tool twice, for "grilling" and "domain-modeling".
4. Record the resolution: post the answer as a **resolution comment**, **close** the issue, and **append a context pointer** to the map's Decisions-so-far.
5. Add newly surfaced tickets (create-then-wire). Move fog that the answer made precise into tickets. Remove each graduated item from **Not yet specified** so it exists only as its new ticket. If the answer shows that any ticket is beyond the destination, **rule it out of scope** instead of resolving it on the route. If the decision invalidates other map content, update or delete that content.

The user may run unblocked tickets in parallel. Expect other sessions to edit the tracker concurrently.
