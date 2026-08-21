---
name: to-spec
description: Turn the current conversation into a spec and publish it to the project issue tracker — no interview, just synthesis of what you've already discussed.
disable-model-invocation: true
---

Use the current conversation context and codebase understanding to produce a spec. Do NOT interview the user. Synthesize only what you already know.

Use the provided issue tracker and triage label vocabulary. If either is missing, tell the user to run `/setup-matt-pocock-skills`.

## Process

1. Explore the repository if you have not already done so. Understand its current state. Use the project's domain glossary throughout the spec and respect ADRs in the area you will change.

2. Identify the seams where you will test the feature. Prefer existing seams. Use the highest possible seam. If you need new seams, propose them at the highest possible point. Prefer one seam across the codebase.

Confirm with the user that the seams match their expectations.

3. Write the spec with the template below. Publish it to the project issue tracker. Apply the `ready-for-agent` triage label. Do not run additional triage.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
