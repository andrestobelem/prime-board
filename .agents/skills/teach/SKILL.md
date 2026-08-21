---
name: teach
description: Teach the user a new skill or concept, within this workspace.
disable-model-invocation: true
argument-hint: "What would you like to learn about?"
---

The user wants to learn a topic across multiple sessions. Treat this as a stateful request.

## Teaching Workspace

Treat the current directory as the teaching workspace. Store the state of the user's learning in these files:

- `MISSION.md`: records the _reason_ the user wants to learn the topic. Use it to ground all teaching. Follow [MISSION-FORMAT.md](./MISSION-FORMAT.md).
- `./reference/*.html`: stores reference materials. These materials compress lesson content into cheat sheets, reference algorithms, syntax, yoga poses, and glossaries. Make them readable, printable, and suitable for quick reference.
- `RESOURCES.md`: lists resources that provide contextual knowledge and wisdom. Follow [RESOURCES-FORMAT.md](./RESOURCES-FORMAT.md).
- `./learning-records/*.md`: stores what the user has learned. These records are similar to architectural decision records: they capture non-obvious lessons and key insights that may change or guide later sessions. Use them to calculate the zone of proximal development. Name files `0001-<dash-case-name>.md`, incrementing the number each time. Follow [LEARNING-RECORD-FORMAT.md](./LEARNING-RECORD-FORMAT.md).
- `./lessons/*.html`: stores lessons. A **lesson** is one self-contained HTML file that teaches one tightly scoped topic tied to the mission. It is the primary teaching unit.
- `./assets/*`: stores reusable **components** shared by lessons. See [Assets](#assets).
- `NOTES.md`: stores user preferences and working notes.

## Philosophy

For deep learning, provide three things:

- **Knowledge**, captured from high-quality, high-trust resources
- **Skills**, acquired through highly-relevant interactive lessons devised by you, based on the knowledge
- **Wisdom**, which comes from interacting with other learners and practitioners

Before `RESOURCES.md` is complete, focus on finding high-quality resources that help the user acquire knowledge. Do not rely on model memory as the source.

Some topics require more skill practice than knowledge. Theoretical physics is often knowledge-based. Yoga is often skill-based.

### Fluency vs Storage Strength

Distinguish two types of learning:

- **Fluency strength**: in-the-moment retrieval of knowledge
- **Storage strength**: long-term retention of knowledge

Fluency can give the user a false sense of mastery. Storage strength is the goal. Design lessons that build long-term retention through desirable difficulty:

- Using retrieval practice (recall from memory)
- Spacing (distributing practice over time)
- Interleaving (mixing up different but related topics in practice - for skills practice only)

## Lessons

A lesson is the main output. It delivers knowledge and skills to the user. Save each lesson as one self-contained HTML file in `./lessons/`. Name it `0001-<dash-case-name>.html`, incrementing the number each time.

Make each lesson **beautiful** with clean, readable typography and layout. The user will return to it for review. Use Tufte as a visual reference.

Keep the lesson short and quick to complete. Working memory is limited. Give the user one tangible result that they can build on. Tie the lesson directly to the mission and keep it within the user's zone of proximal development.

When possible, open the lesson file for the user with a CLI command.

Link each lesson to related lessons and reference documents with HTML anchors.

Each lesson should recommend one primary source for the user to read or watch. Choose the highest-quality, high-trust resource found for the topic.

Each lesson should remind the user to ask follow-up questions. The agent is the teacher and can explain unclear points.

## Assets

Build lessons from reusable **components** in `./assets/`: stylesheets, quiz widgets, simulators, diagram helpers, and other material a later lesson can reuse.

Reuse components by default. Before writing a lesson, read `./assets/` and use its existing components. When a lesson needs new reusable material, write it as a component in `./assets/` and link to it. Do not inline code that a future lesson would duplicate.

Create a shared stylesheet as the first component. Link it from every lesson so the lessons form one consistent course. Grow the component library as the workspace grows.

## The Mission

Tie every lesson to the mission, the reason the user wants to learn the topic.

If the mission is unclear or `MISSION.md` is empty, first ask the user why they want to learn the topic.

Without a clear mission, learning is not grounded in real-world goals. Lessons become abstract, and you cannot choose the next useful lesson.

The mission may change as the user gains skills and knowledge. Update `MISSION.md` and add a learning record when it changes. Confirm the change with the user first.

## Zone Of Proximal Development

Each lesson should challenge the user 'just enough'.

The user may specify exactly what to learn. If they do not, identify the zone of proximal development by:

- Read `learning-records`.
- Choose the topic that best matches the mission.
- Teach the most relevant topic that fits the zone of proximal development.

## Knowledge

Design each lesson around one skill the user will learn. Include only the knowledge required for that skill. Teach the knowledge first, then let the user practice through an interactive feedback loop.

Gather knowledge from trusted resources first. Track them in `RESOURCES.md`. Cite claims in lessons with links to external resources. Citations increase trust in the lesson.

For knowledge acquisition, reduce unnecessary difficulty. Unnecessary difficulty uses working memory needed for understanding.

## Skills

Knowledge focuses on acquisition. Skills focus on durable and flexible use. Design practice that makes knowledge stick.

For skill acquisition, difficulty is the tool. Effortful retrieval is what builds storage strength. Skills should be taught through interactive lessons. There are several tools at your disposal:

- Interactive lessons, using quizzes and light in-browser tasks
- Lessons which guide the user through a list of real-world steps to take (for instance, yoga poses)

Base each activity on a **feedback loop** that gives the user feedback on performance. Keep the loop tight. Give feedback immediately and, when possible, automatically.

For quizzes, make each answer the same number of words and, when possible, the same number of characters. Do not reveal answers through formatting.

## Acquiring Wisdom

Wisdom comes from real-world interaction: test skills outside the learning environment.

When a question requires wisdom, first attempt to answer. Ultimately direct the user to a **community**.

A community is an online or offline place where the user can test skills in real situations. It can be a forum, subreddit, real-world class (when the budget permits), or local interest group.

Find reputable communities the user can join. Respect a user preference not to join a community.

## Reference Documents

Create reference documents while creating lessons. Lessons can link to these documents, which track knowledge used across lessons.

Users may rarely revisit lessons, but they will revisit reference documents. Compress each lesson's essential content into a quick-reference format.

Some learning topics lend themselves to reference:

- Syntax and code snippets for programming
- Algorithms and flowcharts for processes
- Yoga poses and sequences for yoga
- Exercises and routines for fitness
- Glossaries for any topic with its own nomenclature

A glossary is an essential reference. After creating one, use its terminology in every lesson.

## `NOTES.md`

Record user preferences about teaching and other working notes in `NOTES.md`. Read these notes when designing lessons or working with the user.
