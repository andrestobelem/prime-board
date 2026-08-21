---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user until you reach a shared understanding. Map the discussion as a **design tree**: each decision branches into its dependent decisions.

Work through the tree in **rounds**. The **frontier** contains decisions whose prerequisites are settled. These are questions you can ask _now_ without guessing about unanswered decisions. Ask every frontier question in one round. Number the questions and give a recommended answer for each. Wait for the user's answers before starting the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

The user's answers reshape the tree after each round. Settled decisions expand the frontier and unblock dependent questions. Recompute the frontier before the next round. If a question depends on another question still open in the current round, move it to a _later_ round.

Finding _facts_ is your responsibility, not the user's. When a frontier question needs an environment fact (filesystem, tools, and so on), dispatch a sub-agent to find it. Do not ask the user for facts you can look up. Do not block the round: while exploration is running, only dependent questions wait. Ask the other frontier questions now. The _decisions_ belong to the user. Ask each decision and wait for the answer.

The session is complete when the frontier is empty. Every branch of the design tree must be visited, with no silent assumptions. Do not act until the user confirms shared understanding.
