# Design It Twice

When the user wants to explore alternative interfaces for a selected deepening candidate, use this parallel sub-agent pattern. It follows "Design It Twice" (Ousterhout). Treat the first design as provisional.

Uses the vocabulary in [SKILL.md](SKILL.md) — **module**, **interface**, **seam**, **adapter**, **leverage**.

## Process

### 1. Frame the problem space

Before you spawn sub-agents, write a user-facing explanation of the selected candidate's problem space:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](DEEPENING.md))
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete

Show this explanation to the user. Then proceed immediately to Step 2. The user can read and think while the sub-agents work in parallel.

### 2. Spawn sub-agents

Spawn 3+ sub-agents in parallel. Each must produce a **radically different** interface for the deepened module.

Give each sub-agent a separate technical brief with file paths, coupling details, the dependency category from [DEEPENING.md](DEEPENING.md), and the contents behind the seam. Keep each brief independent of the user-facing problem-space explanation in Step 1. Give each agent a different design constraint:

- Agent 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Agent 2: "Maximise flexibility — support many use cases and extension."
- Agent 3: "Optimise for the most common caller — make the default case trivial."
- Agent 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

Include both [SKILL.md](SKILL.md) vocabulary and CONTEXT.md vocabulary in the brief so each sub-agent names things consistently with the architecture language and the project's domain language.

Each sub-agent outputs:

1. Interface (types, methods, params — plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md))
5. Trade-offs — where leverage is high, where it's thin

### 3. Present and compare

Present the designs one at a time so the user can evaluate each design. Then compare them in prose. Compare **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After the comparison, recommend the strongest design and explain why. If elements from different designs combine well, propose a hybrid. Give a clear recommendation instead of a list of options.
