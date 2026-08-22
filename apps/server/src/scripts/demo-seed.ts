#!/usr/bin/env bun
// Seed de demo (AT-143): puebla la DB con datos realistas para probar
// la UI y los clientes. Corre sobre la DB configurada (PRIME_BOARD_DB).
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { bootstrap } from "../db/seed.ts";
import { createActor, createApiKey } from "../domain/actors.ts";
import { createComment } from "../domain/comments.ts";
import { createIssue, updateIssue } from "../domain/issues.ts";
import { createLabel } from "../domain/labels.ts";
import { createProject } from "../domain/projects.ts";
import { getTeam, listTeamStates, type TeamRow } from "../domain/teams.ts";

const config = loadConfig();
const db = openDatabase(config.dbPath);

const seeded = bootstrap(db, config.bootstrap);
if (seeded.created && seeded.adminApiKey) {
  console.log(`Admin API key (save it now, it will not be shown again): ${seeded.adminApiKey}`);
}

const existing = db.query("SELECT count(*) AS n FROM issues").get() as { n: number };
if (existing.n > 0) {
  console.log("Database already has issues; demo seed skipped.");
  process.exit(0);
}

const team =
  getTeam(db, { key: config.bootstrap.teamKey }) ??
  (db.query("SELECT * FROM teams ORDER BY created_at, id LIMIT 1").get() as TeamRow | null);
if (!team) throw new Error("Demo seed requires an initialized Team");
const states = listTeamStates(db, team.id);
const byType = (type: string) => states.find((state) => state.type === type)!;
const admin = db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string };

// Un agente de demo con su propia key.
const agent = createActor(db, { name: "demo-agent", type: "agent" });
const agentKey = createApiKey(db, { actorId: agent.id, name: "demo agent key" });

// Labels de workspace y de team.
const bug = createLabel(db, { name: "bug", color: "#eb5757", teamId: team.id });
const agentReview = createLabel(db, { name: "agent:review", color: "#5e6ad2" });

// Un proyecto liderado por el agente.
const project = createProject(db, {
  name: "Demo: agent onboarding",
  description: "Sample project to explore prime-board",
  state: "started",
  leadId: agent.id,
  teamIds: [team.id],
});

// Issues variados: estados, prioridades, sub-issues, labels y comentarios.
const first = createIssue(db, admin.id, {
  teamId: team.id,
  title: "Explore the prime-board API",
  description: "Use GraphQL, the CLI and MCP to move this issue to Done.",
  priority: 2,
  assigneeId: agent.id,
  projectId: project.id,
});
updateIssue(db, admin.id, first.id, { labelIds: [agentReview.id] });

const child = createIssue(db, agent.id, {
  teamId: team.id,
  title: "Try full-text search",
  parentId: first.id,
  priority: 3,
  projectId: project.id,
});
updateIssue(db, agent.id, child.id, { stateId: byType("started").id });

const bugIssue = createIssue(db, agent.id, {
  teamId: team.id,
  title: "Webhook signature docs are unclear",
  description: "Repro: read the docs. Expected: clarity.",
  priority: 1,
  stateId: byType("unstarted").id,
});
updateIssue(db, agent.id, bugIssue.id, { labelIds: [bug.id] });

const done = createIssue(db, admin.id, {
  teamId: team.id,
  title: "Install prime-board",
  priority: 4,
  projectId: project.id,
});
updateIssue(db, admin.id, done.id, { stateId: byType("completed").id });

createComment(db, agent.id, {
  issueId: first.id,
  body: "Starting with the GraphQL tour. **ETA today.**",
});
createComment(db, admin.id, {
  issueId: first.id,
  body: "Remember to try `pb issue list --json` too.",
});

console.log("Demo data created:");
console.log(
  `  team ${team.key} · project "${project.name}" · 4 issues (${team.key}-1..${team.key}-4)`,
);
console.log(`  actors: admin (human), demo-agent (agent)`);
console.log(`Demo agent API key (save it now, it will not be shown again): ${agentKey.key}`);
