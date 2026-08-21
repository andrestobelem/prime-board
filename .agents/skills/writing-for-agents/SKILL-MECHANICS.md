# Skill mechanics

This is the skill-specific part of [`writing-for-agents`](SKILL.md). It defines the differences for skill documents: frontmatter, invocation choice, and router skills. The universal writing rules are in `SKILL.md`.

## Invocation

Choose one of two invocation modes. Each mode uses the context and cognitive loads differently:

- A **model-invoked** skill keeps a `description`. The agent can invoke it autonomously, and other skills can reach it. The user can still type its name: model invocation always _includes_ user reach. A description adds agent discovery; it does not remove human reach. The description is the skill's top-level context pointer and remains loaded at all times. This context load provides discoverability. A model-invoked skill that contains only reference can also hold shared reference. Other skills can invoke it, so several skills can use one source. Mechanics: omit `disable-model-invocation`, and write a model-facing description with the trigger branches. Apply the pointer-writing rules in `SKILL.md` in full.
- A **user-invoked** skill removes the description from the agent's reach. Only a human who types its name can invoke it. Other skills cannot invoke it. This uses no context load but increases cognitive load: the human must remember that the skill exists. Mechanics: set `disable-model-invocation: true`. The `description` becomes human-facing: use a one-line summary and remove trigger lists.

Choose model invocation only when the agent or another skill must reach the skill autonomously. If a human always invokes it, make it user-invoked and avoid context load.

Shared reference needed by two user-invoked skills cannot live in either skill. Without descriptions, neither skill can invoke the other. Put the reference in a plain file outside the skill system. Any skill can point to that external reference.

## Splitting by invocation

For invocation-based splitting (sequence-based splitting is in `SKILL.md`), split a model-invoked skill when a distinct leading word should trigger it on its own or another skill must reach it. Use a trigger word that appears in your prompts. The new skill has an always-loaded description, so its independent reach must justify the added context load.

## Router skills

When the number of user-invoked skills exceeds what you can remember, use a **router skill**. Make it one user-invoked skill that names the other skills and states when to use each. The human then remembers one skill instead of many. The router can suggest skills but cannot invoke them. User-invoked skills have no description, so only the human can reach them.
