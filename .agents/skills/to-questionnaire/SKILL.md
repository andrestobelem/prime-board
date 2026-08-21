---
name: to-questionnaire
description: Turn a decision you can't fully answer into a questionnaire for someone else to fill in.
disable-model-invocation: true
---

Turn a question the user cannot answer alone into a **questionnaire**. The user gives the Markdown document to one person to complete asynchronously or completes it with that person in a meeting. The recipient has the missing knowledge; the questionnaire collects it.

**Grill the send, not the subject.** Ask the user only about the _send_: the recipient and the required response. The questionnaire then targets the **gap** between the recipient's knowledge and the user's needs.

1. **Who is it going to?** In one exchange, ask for the recipient's role, expertise, and relationship to the user. Use this to set tone and context. Complete this step when you know who the recipient is and what they know that the user does not.

2. **What do you need back?** In one exchange, ask which decisions or facts the user cannot resolve alone and needs from the recipient. Complete this step when you have a concrete list of what the user must be able to do or decide.

3. **Write the questionnaire.** Draft questions that target the gap from steps 1–2. Follow the Document structure below. Write the file to `to-questionnaire-<slug>.md` in the current directory, using the topic as the slug, and report the path. Complete this step when the file exists and covers every item named in step 2.

## Document structure

Frame the document as a **discovery questionnaire**. The user lacks context; the recipient has it. Put the most important questions first because asynchronous review may provide only one response. When there are more than a few questions, group them under `##` headings by theme. Use the template below.

<questionnaire-template>

# <Questionnaire title>

**Purpose:** why this questionnaire exists and the decision riding on it.

**From:** <the user> — **To:** <the recipient> — **How your answers will be used:** <where they go>

## Context

One paragraph orienting a recipient who wasn't in the user's head. Enough to answer well, not a page.

## How to answer

Deadline and rough effort. Partial answers and "I don't know" are useful — flag anything you're unsure of rather than skipping it.

## <Theme heading>

One `##` section per theme. Under each, its questions, most-important-first. Every question is one idea — never compound — with an answer stub directly beneath, and a one-line _why this matters_ only where the question could be misread or invite a throwaway answer.

<question-example>
### What load is the system expected to handle at launch?

_Why this matters: it decides whether we provision for burst traffic now or defer it._

>
</question-example>

## Anything else?

A closing catch-all: anything we didn't ask that we should know?

</questionnaire-template>
