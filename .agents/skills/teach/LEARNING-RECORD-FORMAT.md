# Learning Record Format

Learning records live in `./learning-records/` and use sequential names: `0001-slug.md`, `0002-slug.md`, and so on. Create the directory when writing the first record.

Learning records are the teaching equivalent of ADRs. They capture non-obvious lessons, key insights, and stated prior knowledge that guide future sessions. Use them to calculate the zone of proximal development.

## Template

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

This is the full format. A learning record can be one paragraph. Its value is recording _that_ the user knows something and _why_ it changes the next lesson, not filling out sections.

## Optional sections

Include these sections only when they add genuine value. Most records do not need them.

- **Status** frontmatter (`active | superseded by LR-NNNN`) — useful when an earlier understanding turns out to be wrong and is replaced.
- **Evidence** — how the user demonstrated the understanding (a question answered, an exercise completed, prior experience cited). Useful when the claim might be revisited.
- **Implications** — what this unlocks or rules out for future sessions. Worth recording when non-obvious.

## Numbering

Scan `./learning-records/` for the highest existing number and increment by one.

## When to write a learning record

Write a learning record when any condition below is true:

1. **The user demonstrated genuine understanding of something non-trivial** — record evidence that the user can use the concept, not only that they saw it. This sets the minimum for the next lesson.
2. **The user disclosed prior knowledge** — "I already know X." Record it so future sessions do not repeat the topic. Also record the claimed _depth_.
3. **A misconception was corrected** — the user previously believed something incorrect and now understands why. This can predict related stumbling blocks.
4. **The mission changed because of learning** — the user discovered a different interest. Cross-link to [[MISSION.md]] and update it.

### What does _not_ qualify

- Material that was only covered. Coverage is not learning. Wait for evidence.
- A term already defined in [[GLOSSARY.md]]. Do not duplicate it.
- Session activity logs. Learning records are not a journal. They are decision-grade insights.

## Supersession

When a later record contradicts an earlier record because understanding changed, mark the old record `Status: superseded by LR-NNNN`. Do not delete it. The history of changing understanding is useful evidence.
