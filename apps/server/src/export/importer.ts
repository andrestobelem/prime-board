// Reconstrucción de la DB desde el repo (AT-157, Fase 2).
//
// La DB pasa a ser un índice derivado: se puede borrar y regenerar desde
// `.prime-board/`. Lo único que NO está en el repo son las credenciales
// (API keys y secrets de webhooks), así que se preservan re-vinculándolas
// por nombre de actor — de lo contrario un rebuild dejaría a todos afuera.
import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { newId, now } from "../db/util.ts";

export interface RebuildResult {
  issues: number;
  events: number;
  comments: number;
  preservedKeys: number;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

export function rebuildFromRepo(db: Database, rootDir: string): RebuildResult {
  const base = join(rootDir, ".prime-board");
  if (!existsSync(base)) throw new Error(`No .prime-board directory in ${rootDir}`);

  // 1. Credenciales locales: se guardan por NOMBRE de actor porque los ids cambian.
  const keys = db.query(
    "SELECT api_keys.name, api_keys.hash, api_keys.last_used_at, api_keys.created_at, actors.name AS actor_name " +
    "FROM api_keys JOIN actors ON actors.id = api_keys.actor_id",
  ).all() as Array<Record<string, string | null>>;
  const webhooks = db.query("SELECT * FROM webhooks").all() as Array<Record<string, unknown>>;

  const result: RebuildResult = { issues: 0, events: 0, comments: 0, preservedKeys: 0 };

  db.transaction(() => {
    // 2. Vaciar el índice (orden inverso a las FKs).
    for (const table of [
      "issue_labels", "activity", "comments", "api_keys", "webhooks", "issues",
      "milestones", "project_teams", "projects", "labels", "workflow_states", "teams",
      "actors", "workspace",
    ]) {
      db.query(`DELETE FROM ${table}`).run();
    }

    const timestamp = now();
    // 3. Workspace y actores.
    const workspace = readJson(join(base, "meta", "workspace.json"));
    db.query("INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
      .run(newId(), workspace.name ?? "Prime Board", workspace.urlKey ?? "prime-board", timestamp);

    const actorIds = new Map<string, string>();
    for (const actor of readJson(join(base, "meta", "actors.json")) as Array<Record<string, string | null>>) {
      const id = newId();
      actorIds.set(actor.name!, id);
      db.query("INSERT INTO actors (id, name, email, type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)")
        .run(id, actor.name, actor.email ?? null, actor.type, timestamp);
    }

    // 4. Teams, estados y labels (clave: team key + nombre).
    const teamIds = new Map<string, string>();
    const stateIds = new Map<string, string>();
    const labelIds = new Map<string, string>();
    for (const team of readJson(join(base, "meta", "teams.json")) as Array<Record<string, any>>) {
      const teamId = newId();
      teamIds.set(team.key, teamId);
      db.query("INSERT INTO teams (id, name, key, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)")
        .run(teamId, team.name, team.key, team.description ?? null, timestamp);
      for (const state of team.states ?? []) {
        const stateId = newId();
        stateIds.set(`${team.key}/${state.name}`, stateId);
        db.query(
          "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        ).run(stateId, teamId, state.name, state.type, state.color, state.position, timestamp);
      }
      for (const label of team.labels ?? []) {
        const labelId = newId();
        labelIds.set(label.name, labelId);
        db.query("INSERT INTO labels (id, name, color, team_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
          .run(labelId, label.name, label.color, teamId, timestamp);
      }
    }
    for (const label of readJson(join(base, "meta", "workspace-labels.json")) as Array<Record<string, string>>) {
      const labelId = newId();
      labelIds.set(label.name, labelId);
      db.query("INSERT INTO labels (id, name, color, team_id, created_at) VALUES (?1, ?2, ?3, NULL, ?4)")
        .run(labelId, label.name, label.color, timestamp);
    }

    // 5. Proyectos y milestones.
    const projectIds = new Map<string, string>();
    const milestoneIds = new Map<string, string>();
    for (const project of readJson(join(base, "meta", "projects.json")) as Array<Record<string, any>>) {
      const projectId = newId();
      projectIds.set(project.name, projectId);
      db.query(
        `INSERT INTO projects (id, name, description, state, lead_id, target_date, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
      ).run(projectId, project.name, project.description ?? null, project.state,
            project.lead ? actorIds.get(project.lead) ?? null : null,
            project.targetDate ?? null, timestamp, project.archived ? timestamp : null);
      for (const teamKey of project.teams ?? []) {
        const teamId = teamIds.get(teamKey);
        if (teamId) {
          db.query("INSERT INTO project_teams (project_id, team_id) VALUES (?1, ?2)").run(projectId, teamId);
        }
      }
      for (const milestone of project.milestones ?? []) {
        const milestoneId = newId();
        milestoneIds.set(`${project.name}/${milestone.name}`, milestoneId);
        db.query(
          `INSERT INTO milestones (id, project_id, name, description, target_date, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
        ).run(milestoneId, projectId, milestone.name, milestone.description ?? null,
              milestone.targetDate ?? null, milestone.position ?? 0, timestamp);
      }
    }

    // 6. Issues: primera pasada sin parent (se resuelve después).
    const issueIds = new Map<string, string>();
    const snapshots = readdirSync(join(base, "issues"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson(join(base, "issues", file)) as Record<string, any>)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    for (const issue of snapshots) {
      const [teamKey, numberText] = String(issue.id).split("-");
      const teamId = teamIds.get(teamKey!);
      if (!teamId) throw new Error(`Issue ${issue.id} references unknown team ${teamKey}`);
      const stateId = stateIds.get(`${teamKey}/${issue.state}`);
      if (!stateId) throw new Error(`Issue ${issue.id} references unknown state ${issue.state}`);
      const id = newId();
      issueIds.set(issue.id, id);
      db.query(
        `INSERT INTO issues (id, team_id, number, title, description, state_id, priority, assignee_id,
           parent_id, project_id, milestone_id, creator_id, sort_order, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, 0, ?12, ?13, ?14)`,
      ).run(
        id, teamId, Number(numberText), issue.title, issue.description ?? null, stateId,
        issue.priority ?? 0, issue.assignee ? actorIds.get(issue.assignee) ?? null : null,
        issue.project ? projectIds.get(issue.project) ?? null : null,
        issue.milestone && issue.project ? milestoneIds.get(`${issue.project}/${issue.milestone}`) ?? null : null,
        actorIds.get(issue.creator) ?? [...actorIds.values()][0]!,
        issue.createdAt, issue.updatedAt ?? issue.createdAt, issue.archivedAt ?? null,
      );
      for (const labelName of issue.labels ?? []) {
        const labelId = labelIds.get(labelName);
        if (labelId) {
          db.query("INSERT INTO issue_labels (issue_id, label_id) VALUES (?1, ?2)").run(id, labelId);
        }
      }
      for (const comment of issue.comments ?? []) {
        db.query("INSERT INTO comments (id, issue_id, actor_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
          .run(newId(), id, actorIds.get(comment.actor) ?? null, comment.body, comment.createdAt);
        result.comments += 1;
      }
      result.issues += 1;
    }

    // 7. Segunda pasada: parents.
    for (const issue of snapshots) {
      if (!issue.parent) continue;
      const child = issueIds.get(issue.id);
      const parent = issueIds.get(issue.parent);
      if (child && parent) {
        db.query("UPDATE issues SET parent_id = ?1 WHERE id = ?2").run(parent, child);
      }
    }

    // 8. Numeración: se deriva, no se persiste (riesgo 6 del doc de AT-153).
    for (const [teamKey, teamId] of teamIds) {
      const max = db
        .query("SELECT coalesce(max(number), 0) AS max FROM issues WHERE team_id = ?1")
        .get(teamId) as { max: number };
      db.query("UPDATE teams SET next_issue_number = ?1 WHERE id = ?2").run(max.max + 1, teamId);
      void teamKey;
    }

    // 9. Historial desde el log.
    for (const file of readdirSync(join(base, "log")).filter((f) => f.endsWith(".jsonl"))) {
      const identifier = file.replace(/\.jsonl$/, "");
      const issueId = issueIds.get(identifier);
      if (!issueId) continue;
      const contents = readFileSync(join(base, "log", file), "utf8").trim();
      if (!contents) continue;
      for (const line of contents.split("\n")) {
        const event = JSON.parse(line);
        db.query(
          "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        ).run(newId(), issueId, actorIds.get(event.actor) ?? [...actorIds.values()][0]!,
              event.type, JSON.stringify(event.payload ?? {}), event.ts);
        result.events += 1;
      }
    }

    // 10. Restaurar credenciales locales re-vinculando por nombre.
    for (const key of keys) {
      const actorId = actorIds.get(key.actor_name as string);
      if (!actorId) continue;
      db.query("INSERT INTO api_keys (id, actor_id, name, hash, last_used_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .run(newId(), actorId, key.name, key.hash, key.last_used_at, key.created_at);
      result.preservedKeys += 1;
    }
    for (const hook of webhooks) {
      db.query(
        "INSERT INTO webhooks (id, url, secret, events, enabled, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run(hook.id, hook.url, hook.secret, hook.events, hook.enabled, hook.created_at);
    }
  })();

  return result;
}
