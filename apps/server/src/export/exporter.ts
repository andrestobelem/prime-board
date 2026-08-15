// Exportador del board al repo (AT-156, Fase 1 de la épica "Repo como fuente de verdad").
//
// Principios (docs/investigacion-tickets-en-repo.md):
//  - Determinista: exportar dos veces sin cambios no produce diff.
//  - Claves naturales, no UUIDs: los ids no sobreviven a un merge entre clones.
//  - Sin credenciales: hashes de API keys y secrets de webhooks NUNCA salen al repo.
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";

/** JSON con claves ordenadas: sin esto, el diff cambia por reordenamientos casuales. */
function stableStringify(value: unknown): string {
  const seen = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(seen);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, seen(v)]),
      );
    }
    return input;
  };
  return `${JSON.stringify(seen(value), null, 2)}\n`;
}

interface Lookups {
  actors: Map<string, string>;
  states: Map<string, string>;
  projects: Map<string, string>;
  milestones: Map<string, string>;
  labels: Map<string, string>;
}

function buildLookups(db: Database): Lookups {
  const toMap = (sql: string) =>
    new Map(db.query(sql).values().map((row) => [row[0] as string, row[1] as string]));
  return {
    actors: toMap("SELECT id, name FROM actors"),
    states: toMap("SELECT id, name FROM workflow_states"),
    projects: toMap("SELECT id, name FROM projects"),
    milestones: toMap("SELECT id, name FROM milestones"),
    labels: toMap("SELECT id, name FROM labels"),
  };
}

/** Traduce los ids de un payload de actividad a nombres legibles y estables. */
function resolvePayload(
  type: string,
  payload: Record<string, unknown>,
  lookups: Lookups,
  teamKeys: Map<string, string>,
  identifiers: Map<string, string>,
  comments: Map<string, string>,
): Record<string, unknown> {
  if (type === "commented") {
    // El id del comentario es un UUID que se regenera en cada rebuild: fuera del
    // repo. Los eventos previos a AT-165 no traen `body`, así que se completa
    // desde la tabla de comentarios — si no, el rebuild perdería esos comentarios.
    const { commentId, body, ...rest } = payload as Record<string, unknown>;
    const resolved = body ?? (typeof commentId === "string" ? comments.get(commentId) ?? null : null);
    return { ...rest, ...(resolved != null ? { body: resolved } : {}) };
  }
  if (type === "created") {
    // El evento `created` trae el estado inicial completo: se traduce entero.
    const { teamId, stateId, assigneeId, parentId, projectId, milestoneId, ...rest } = payload as Record<string, any>;
    return {
      ...rest,
      team: teamId ? teamKeys.get(teamId) ?? null : null,
      state: stateId ? lookups.states.get(stateId) ?? null : null,
      assignee: assigneeId ? lookups.actors.get(assigneeId) ?? null : null,
      parent: parentId ? identifiers.get(parentId) ?? null : null,
      project: projectId ? lookups.projects.get(projectId) ?? null : null,
      milestone: milestoneId ? lookups.milestones.get(milestoneId) ?? null : null,
    };
  }
  const map: Record<string, Map<string, string>> = {
    state_changed: lookups.states,
    assigned: lookups.actors,
    project_changed: lookups.projects,
    milestone_changed: lookups.milestones,
    parent_changed: identifiers,
  };
  const table = map[type];
  if (!table) return payload;
  const translate = (value: unknown) =>
    typeof value === "string" ? table.get(value) ?? value : value;
  return {
    ...payload,
    ...(payload.from !== undefined ? { from: translate(payload.from) } : {}),
    ...(payload.to !== undefined ? { to: translate(payload.to) } : {}),
  };
}

export interface ExportOptions {
  /** Exportar solo un team (por key). Sin esto, exporta todo el workspace. */
  teamKey?: string | null;
}

export interface ExportResult {
  issues: number;
  events: number;
  files: number;
}

export function exportBoard(db: Database, rootDir: string, options: ExportOptions = {}): ExportResult {
  const base = join(rootDir, ".prime-board");
  // Se regenera de cero: así los borrados también quedan reflejados en el diff.
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, "meta"), { recursive: true });
  mkdirSync(join(base, "issues"), { recursive: true });
  mkdirSync(join(base, "log"), { recursive: true });

  const lookups = buildLookups(db);
  const teamKeys = new Map(db.query("SELECT id, key FROM teams").values().map((r) => [r[0] as string, r[1] as string]));
  const commentBodies = new Map(
    db.query("SELECT id, body FROM comments").values().map((r) => [r[0] as string, r[1] as string]),
  );
  const identifiers = new Map(
    db.query(
      "SELECT issues.id, teams.key || '-' || issues.number FROM issues JOIN teams ON teams.id = issues.team_id",
    ).values().map((r) => [r[0] as string, r[1] as string]),
  );
  let files = 0;
  const write = (path: string, contents: string) => {
    Bun.write(path, contents);
    files += 1;
  };

  const teamFilter = options.teamKey
    ? (db.query("SELECT id FROM teams WHERE key = ?1").get(options.teamKey.toUpperCase()) as { id: string } | null)
    : null;
  if (options.teamKey && !teamFilter) {
    throw new Error(`Team not found: ${options.teamKey}`);
  }

  // Alcance del export: un rebuild desde un export parcial borraría lo que no
  // está en el repo, así que queda registrado y el importador lo verifica.
  write(join(base, "meta", "export.json"), stableStringify({
    scope: options.teamKey ? `team:${options.teamKey.toUpperCase()}` : "workspace",
  }));

  // ---- meta ----
  const workspace = db.query("SELECT name, url_key FROM workspace LIMIT 1").get() as
    | { name: string; url_key: string }
    | null;
  write(join(base, "meta", "workspace.json"), stableStringify({ name: workspace?.name, urlKey: workspace?.url_key }));

  const actors = db.query("SELECT name, email, type FROM actors ORDER BY name").all() as Array<Record<string, unknown>>;
  write(join(base, "meta", "actors.json"), stableStringify(actors));

  const teams = db
    .query(`SELECT id, key, name, description FROM teams ${teamFilter ? "WHERE id = ?1" : ""} ORDER BY key`)
    .all(...(teamFilter ? [teamFilter.id] : []) as never[]) as Array<{ id: string; key: string; name: string; description: string | null }>;
  write(join(base, "meta", "teams.json"), stableStringify(teams.map((team) => ({
    key: team.key,
    name: team.name,
    description: team.description,
    states: db
      .query("SELECT name, type, color, position FROM workflow_states WHERE team_id = ?1 ORDER BY position, name")
      .all(team.id),
    labels: db
      .query("SELECT name, color FROM labels WHERE team_id = ?1 ORDER BY name")
      .all(team.id),
  }))));

  write(join(base, "meta", "workspace-labels.json"), stableStringify(
    db.query("SELECT name, color FROM labels WHERE team_id IS NULL ORDER BY name").all(),
  ));

  const projects = db.query("SELECT id, name, description, state, lead_id, target_date, archived_at FROM projects ORDER BY name")
    .all() as Array<Record<string, any>>;
  write(join(base, "meta", "projects.json"), stableStringify(projects.map((project) => ({
    name: project.name,
    description: project.description,
    state: project.state,
    lead: project.lead_id ? lookups.actors.get(project.lead_id) ?? null : null,
    targetDate: project.target_date,
    archived: Boolean(project.archived_at),
    teams: db.query(
      "SELECT teams.key FROM project_teams JOIN teams ON teams.id = project_teams.team_id WHERE project_id = ?1 ORDER BY teams.key",
    ).values(project.id).map((row) => row[0]),
    milestones: db
      .query("SELECT name, description, target_date AS targetDate, position FROM milestones WHERE project_id = ?1 ORDER BY position, name")
      .all(project.id),
  }))));

  // ---- issues: snapshot + log ----
  const issues = db
    .query(
      `SELECT issues.*, teams.key AS team_key FROM issues JOIN teams ON teams.id = issues.team_id
       ${teamFilter ? "WHERE issues.team_id = ?1" : ""}
       ORDER BY teams.key, issues.number`,
    )
    .all(...(teamFilter ? [teamFilter.id] : []) as never[]) as Array<Record<string, any>>;

  let events = 0;
  for (const issue of issues) {
    const identifier = `${issue.team_key}-${issue.number}`;
    const parent = issue.parent_id
      ? (db.query(
          "SELECT teams.key || '-' || issues.number AS ident FROM issues JOIN teams ON teams.id = issues.team_id WHERE issues.id = ?1",
        ).get(issue.parent_id) as { ident: string } | null)
      : null;

    // Markdown con front-matter: legible en el diff de un PR (AT-159).
    // Los comentarios NO se duplican acá: ya viven en el log como eventos
    // `commented` con autor, fecha y body — el importador los reconstruye de ahí.
    const frontMatter = {
      id: identifier,
      title: issue.title,
      team: issue.team_key,
      state: lookups.states.get(issue.state_id) ?? null,
      priority: issue.priority,
      assignee: issue.assignee_id ? lookups.actors.get(issue.assignee_id) ?? null : null,
      creator: lookups.actors.get(issue.creator_id) ?? null,
      parent: parent?.ident ?? null,
      project: issue.project_id ? lookups.projects.get(issue.project_id) ?? null : null,
      milestone: issue.milestone_id ? lookups.milestones.get(issue.milestone_id) ?? null : null,
      labels: db.query(
        "SELECT labels.name FROM issue_labels JOIN labels ON labels.id = issue_labels.label_id WHERE issue_id = ?1 ORDER BY labels.name",
      ).values(issue.id).map((row) => row[0]),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      archivedAt: issue.archived_at,
    };
    const yaml = toYaml(frontMatter, { sortMapEntries: true, lineWidth: 0 });
    const body = issue.description ? `\n${String(issue.description).replace(/\s*$/, "")}\n` : "";
    write(join(base, "issues", `${identifier}.md`), `---\n${yaml}---\n\n# ${issue.title}\n${body}`);

    const activity = db
      .query("SELECT actor_id, type, payload, created_at FROM activity WHERE issue_id = ?1 ORDER BY created_at, id")
      .all(issue.id) as Array<{ actor_id: string; type: string; payload: string; created_at: string }>;
    const lines = activity.map((event) => {
      events += 1;
      return JSON.stringify({
        actor: lookups.actors.get(event.actor_id) ?? null,
        issue: identifier,
        payload: resolvePayload(event.type, JSON.parse(event.payload), lookups, teamKeys, identifiers, commentBodies),
        ts: event.created_at,
        type: event.type,
      });
    });
    write(join(base, "log", `${identifier}.jsonl`), lines.length > 0 ? `${lines.join("\n")}\n` : "");
  }

  return { issues: issues.length, events, files };
}
