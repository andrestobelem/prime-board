# MISSION.md Format

`MISSION.md` lives at the workspace root. It records the _reason_ the user is learning the topic. Every teaching decision, including the next lesson, resources, and exercises, must trace back to this document.

## Template

```md
# Mission: {Topic}

## Why
{1-3 sentences. The concrete real-world goal the user is chasing. What changes in their life or work when they have this skill? Avoid abstract framings like "to understand X" — push for the underlying outcome.}

## Success looks like
- {A specific, observable thing the user will be able to do}
- {Another specific thing}
- {…}

## Constraints
- {Time, budget, prior commitments, learning preferences, anything that bounds the approach}

## Out of scope
- {Adjacent topics the user explicitly does not want to chase right now — protects the zone of proximal development}
```

## Rules

- **One mission per workspace.** If the user wants to learn two unrelated topics, use two workspaces.
- **Use concrete goals.** "Run a half marathon by October" is better than "get fitter." "Ship a Rust CLI to my team" is better than "learn Rust."
- **Challenge vague goals.** If the user cannot state why, interview them before writing. A bad mission is worse than no mission.
- **Revise when the goal changes.** Update this file when reality changes. Do not let a stale mission guide future sessions.
- **Keep it short.** If `MISSION.md` exceeds one screen, it is a plan instead of a compass.
