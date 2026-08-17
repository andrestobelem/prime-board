// Exportador del board al repo (AT-156, Fase 1 de la épica "Repo como fuente de verdad").
//
// Principios (docs/investigacion-tickets-en-repo.md):
//  - Determinista: exportar dos veces sin cambios no produce diff.
//  - Claves naturales, no UUIDs: los ids no sobreviven a un merge entre clones.
//  - Sin credenciales: hashes de API keys y secrets de webhooks NUNCA salen al repo.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { translateActivityRefs, type RefTable } from "../domain/activity-schema.ts";
import { translateSavedViewFilter, type SavedViewRefTable } from "./saved-view-filter.ts";

/** JSON con claves ordenadas: sin esto, el diff cambia por reordenamientos casuales. */
/**
 * Escribe solo si el contenido cambió: evita reescribir 100+ archivos (y ensuciar
 * sus mtimes) en cada mutación cuando la mayoría no cambió (AT-166).
 */
function makeWriter(onWrite: () => void) {
  return (path: string, contents: string): void => {
    if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
    Bun.write(path, contents);
    onWrite();
  };
}

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
  cycles: Map<string, string>;
  labels: Map<string, string>;
}

function uniqueNaturalMap(rows: Array<[string, string]>, resource: string): Map<string, string> {
  const idsByNatural = new Map<string, string>();
  const result = new Map<string, string>();
  for (const [id, natural] of rows) {
    const previous = idsByNatural.get(natural);
    if (previous && previous !== id) {
      throw new Error(
        `Cannot export saved view filters: ambiguous ${resource} reference "${natural}"`,
      );
    }
    idsByNatural.set(natural, id);
    result.set(id, natural);
  }
  return result;
}

function savedViewNaturalKey(view: {
  name: string;
  scope: string;
  team: string | null;
  owner: string;
}): string {
  return JSON.stringify([view.scope, view.team, view.owner, view.name]);
}

function savedViewsUseField(views: Array<Record<string, any>>, field: string): boolean {
  const visit = (filter: unknown): boolean => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
    const record = filter as Record<string, any>;
    if (field in record) return true;
    return ["and", "or"].some(
      (branch) =>
        Array.isArray(record[branch]) && record[branch].some((item: unknown) => visit(item)),
    );
  };
  return views.some((view) => visit(view.filter));
}

function buildSavedViewLookups(
  db: Database,
  lookups: Lookups,
  teamKeys: Map<string, string>,
  identifiers: Map<string, string>,
  views: Array<Record<string, any>>,
): Record<SavedViewRefTable, Map<string, string>> {
  const values = (sql: string) =>
    db
      .query(sql)
      .values()
      .map((row) => [row[0] as string, row[1] as string] as [string, string]);
  const projects = values("SELECT id, name FROM projects");
  const milestones = values(
    "SELECT milestones.id, projects.name || '/' || milestones.name " +
      "FROM milestones JOIN projects ON projects.id = milestones.project_id",
  );
  const needsProjects = savedViewsUseField(views, "project");
  const needsMilestones = savedViewsUseField(views, "milestone");
  return {
    teams: teamKeys,
    states: uniqueNaturalMap(
      values(
        "SELECT workflow_states.id, teams.key || '/' || workflow_states.name " +
          "FROM workflow_states JOIN teams ON teams.id = workflow_states.team_id",
      ),
      "workflow state",
    ),
    actors: uniqueNaturalMap(
      [...lookups.actors].map(([id, name]) => [id, name]),
      "actor",
    ),
    projects: needsProjects ? uniqueNaturalMap(projects, "project") : new Map(projects),
    milestones: needsMilestones ? uniqueNaturalMap(milestones, "milestone") : new Map(milestones),
    labels: uniqueNaturalMap(
      values(
        "SELECT labels.id, " +
          "CASE WHEN labels.team_id IS NULL THEN 'workspace/' || labels.name " +
          "ELSE teams.key || '/' || labels.name END " +
          "FROM labels LEFT JOIN teams ON teams.id = labels.team_id",
      ),
      "label",
    ),
    issues: identifiers,
    cycles: lookups.cycles,
  };
}

function buildLookups(db: Database): Lookups {
  const toMap = (sql: string) =>
    new Map(
      db
        .query(sql)
        .values()
        .map((row) => [row[0] as string, row[1] as string]),
    );
  return {
    actors: toMap("SELECT id, name FROM actors"),
    states: toMap("SELECT id, name FROM workflow_states"),
    projects: toMap("SELECT id, name FROM projects"),
    milestones: toMap("SELECT id, name FROM milestones"),
    cycles: toMap(
      "SELECT cycles.id, teams.key || '/' || cycles.number FROM cycles JOIN teams ON teams.id = cycles.team_id",
    ),
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
    const resolved =
      body ?? (typeof commentId === "string" ? (comments.get(commentId) ?? null) : null);
    return { ...rest, ...(resolved != null ? { body: resolved } : {}) };
  }
  // Qué campos son referencia y a qué tabla vive en un solo lugar (AT-187):
  // acá solo se resuelve id→clave natural con los lookups de este export.
  const resolve = (table: RefTable, value: string): string | undefined =>
    (
      ({
        states: lookups.states,
        actors: lookups.actors,
        projects: lookups.projects,
        milestones: lookups.milestones,
        cycles: lookups.cycles,
        issues: identifiers,
        teams: teamKeys,
      }) satisfies Record<RefTable, Map<string, string>>
    )[table].get(value);
  return translateActivityRefs(type, payload, resolve);
}

/**
 * Campos de relaciones del front-matter: listas de identificadores, ordenadas
 * y omitidas cuando están vacías (evita churn en issues sin relaciones).
 */
function relationFields(db: Database, issueId: string): Record<string, string[]> {
  const idents = (sql: string) =>
    db
      .query(sql)
      .values(issueId)
      .map((row) => row[0] as string);
  // El otro extremo de cada fila canónica, según de qué lado esté este issue.
  const fromSource = (type: string) =>
    idents(
      `SELECT teams.key || '-' || issues.number FROM issue_relations
     JOIN issues ON issues.id = issue_relations.related_id
     JOIN teams ON teams.id = issues.team_id
     WHERE issue_relations.issue_id = ?1 AND issue_relations.type = '${type}'
     ORDER BY teams.key, issues.number`,
    );
  const fromTarget = (type: string) =>
    idents(
      `SELECT teams.key || '-' || issues.number FROM issue_relations
     JOIN issues ON issues.id = issue_relations.issue_id
     JOIN teams ON teams.id = issues.team_id
     WHERE issue_relations.related_id = ?1 AND issue_relations.type = '${type}'
     ORDER BY teams.key, issues.number`,
    );
  const blockedBy = fromTarget("blocks");
  const related = fromSource("related");
  const duplicateOf = fromSource("duplicate_of");
  return {
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
    ...(related.length > 0 ? { related } : {}),
    ...(duplicateOf.length > 0 ? { duplicateOf } : {}),
  };
}

interface ExportContext {
  lookups: Lookups;
  teamKeys: Map<string, string>;
  identifiers: Map<string, string>;
  commentBodies: Map<string, string>;
}

function buildContext(db: Database): ExportContext {
  return {
    lookups: buildLookups(db),
    teamKeys: new Map(
      db
        .query("SELECT id, key FROM teams")
        .values()
        .map((r) => [r[0] as string, r[1] as string]),
    ),
    identifiers: new Map(
      db
        .query(
          "SELECT issues.id, teams.key || '-' || issues.number FROM issues JOIN teams ON teams.id = issues.team_id",
        )
        .values()
        .map((r) => [r[0] as string, r[1] as string]),
    ),
    commentBodies: new Map(
      db
        .query("SELECT id, body FROM comments")
        .values()
        .map((r) => [r[0] as string, r[1] as string]),
    ),
  };
}

/** Escribe el snapshot markdown y el log de un issue. Devuelve cuántos eventos escribió. */
function writeIssue(
  db: Database,
  base: string,
  issue: Record<string, any>,
  { lookups, teamKeys, identifiers, commentBodies }: ExportContext,
  write: (path: string, contents: string) => void,
): number {
  const identifier = `${issue.team_key}-${issue.number}`;
  const parent = issue.parent_id
    ? (db
        .query(
          "SELECT teams.key || '-' || issues.number AS ident FROM issues JOIN teams ON teams.id = issues.team_id WHERE issues.id = ?1",
        )
        .get(issue.parent_id) as { ident: string } | null)
    : null;

  // Markdown con front-matter: legible en el diff de un PR (AT-159).
  // Los comentarios NO se duplican acá: ya viven en el log como eventos
  // `commented` con autor, fecha y body — el importador los reconstruye de ahí.
  const creatorName = lookups.actors.get(issue.creator_id) ?? null;
  const cycleRef = issue.cycle_id
    ? (db
        .query(
          `SELECT teams.key || '/' || cycles.number AS ref
           FROM cycles JOIN teams ON teams.id = cycles.team_id
           WHERE cycles.id = ?1`,
        )
        .get(issue.cycle_id) as { ref: string } | null)
    : null;
  const frontMatter = {
    id: identifier,
    title: issue.title,
    team: issue.team_key,
    state: lookups.states.get(issue.state_id) ?? null,
    priority: issue.priority,
    assignee: issue.assignee_id ? (lookups.actors.get(issue.assignee_id) ?? null) : null,
    creator: creatorName,
    parent: parent?.ident ?? null,
    project: issue.project_id ? (lookups.projects.get(issue.project_id) ?? null) : null,
    milestone: issue.milestone_id ? (lookups.milestones.get(issue.milestone_id) ?? null) : null,
    cycle: cycleRef?.ref ?? null,
    sortOrder: issue.sort_order ?? 0,
    labels: db
      .query(
        `SELECT labels.name, teams.key AS team_key
         FROM issue_labels
         JOIN labels ON labels.id = issue_labels.label_id
         LEFT JOIN teams ON teams.id = labels.team_id
         WHERE issue_labels.issue_id = ?1
         ORDER BY team_key, labels.name`,
      )
      .all(issue.id)
      .map((row) => row as { name: string; team_key: string | null })
      .map((row) => ({ name: row.name, team: row.team_key ?? null })),
    // Relaciones (AT-175/AT-178): se guardan una sola vez — blockedBy en el
    // extremo bloqueado; related y duplicateOf en el extremo origen de la fila.
    ...relationFields(db, issue.id),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    archivedAt: issue.archived_at,
  };
  const yaml = toYaml(frontMatter, { sortMapEntries: true, lineWidth: 0 });
  const body = issue.description ? `\n${String(issue.description).replace(/\s*$/, "")}\n` : "";
  // PRB-222: autoría visible fuera del YAML; el importador la descarta del body.
  const byline = creatorName ? `\nCreated by ${creatorName}.\n` : "";
  write(
    join(base, "issues", `${identifier}.md`),
    `---\n${yaml}---\n\n# ${issue.title}\n${byline}${body}`,
  );
  const activity = db
    .query(
      "SELECT actor_id, type, payload, created_at FROM activity WHERE issue_id = ?1 ORDER BY created_at, id",
    )
    .all(issue.id) as Array<{
    actor_id: string;
    type: string;
    payload: string;
    created_at: string;
  }>;
  const lines = activity.map((event) =>
    JSON.stringify({
      actor: lookups.actors.get(event.actor_id) ?? null,
      issue: identifier,
      payload: resolvePayload(
        event.type,
        JSON.parse(event.payload),
        lookups,
        teamKeys,
        identifiers,
        commentBodies,
      ),
      ts: event.created_at,
      type: event.type,
    }),
  );
  write(join(base, "log", `${identifier}.jsonl`), lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return lines.length;
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

export function exportBoard(
  db: Database,
  rootDir: string,
  options: ExportOptions = {},
): ExportResult {
  const base = join(rootDir, ".prime-board");
  // No se borra todo de entrada: se escribe lo que cambió y al final se barren
  // los archivos que ya no corresponden (AT-166). Así un sync completo con datos
  // sin cambios no toca ningún archivo.
  const written = new Set<string>();
  mkdirSync(join(base, "meta"), { recursive: true });
  mkdirSync(join(base, "issues"), { recursive: true });
  mkdirSync(join(base, "log"), { recursive: true });

  const context = buildContext(db);
  const { lookups } = context;
  let files = 0;
  const baseWrite = makeWriter(() => {
    files += 1;
  });
  const write = (path: string, contents: string) => {
    written.add(path);
    baseWrite(path, contents);
  };

  const teamFilter = options.teamKey
    ? (db.query("SELECT id FROM teams WHERE key = ?1").get(options.teamKey.toUpperCase()) as {
        id: string;
      } | null)
    : null;
  if (options.teamKey && !teamFilter) {
    throw new Error(`Team not found: ${options.teamKey}`);
  }

  // Alcance del export: un rebuild desde un export parcial borraría lo que no
  // está en el repo, así que queda registrado y el importador lo verifica.
  write(
    join(base, "meta", "export.json"),
    stableStringify({
      scope: options.teamKey ? `team:${options.teamKey.toUpperCase()}` : "workspace",
    }),
  );

  // ---- meta ----
  const workspace = db.query("SELECT name, url_key FROM workspace LIMIT 1").get() as {
    name: string;
    url_key: string;
  } | null;
  write(
    join(base, "meta", "workspace.json"),
    stableStringify({ name: workspace?.name, urlKey: workspace?.url_key }),
  );

  const actors = db
    .query(
      "SELECT id, name, email, type, workspace_role AS workspaceRole FROM actors ORDER BY name",
    )
    .all() as Array<Record<string, unknown>>;
  write(join(base, "meta", "actors.json"), stableStringify(actors));

  const teams = db
    .query(
      `SELECT id, key, name, description, default_state_id FROM teams ${teamFilter ? "WHERE id = ?1" : ""} ORDER BY key`,
    )
    .all(...((teamFilter ? [teamFilter.id] : []) as never[])) as Array<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    default_state_id: string | null;
  }>;
  write(
    join(base, "meta", "teams.json"),
    stableStringify(
      teams.map((team) => ({
        key: team.key,
        name: team.name,
        description: team.description,
        defaultState: team.default_state_id
          ? (lookups.states.get(team.default_state_id) ?? null)
          : null,
        states: db
          .query(
            "SELECT name, type, color, position FROM workflow_states WHERE team_id = ?1 ORDER BY position, name",
          )
          .all(team.id),
        labels: db
          .query("SELECT name, color FROM labels WHERE team_id = ?1 ORDER BY name")
          .all(team.id),
        members: db
          .query(
            `SELECT actors.name AS actor, team_memberships.role
             FROM team_memberships
             JOIN actors ON actors.id = team_memberships.actor_id
             WHERE team_memberships.team_id = ?1
             ORDER BY actors.name, team_memberships.role`,
          )
          .all(team.id),
      })),
    ),
  );

  write(
    join(base, "meta", "workspace-labels.json"),
    stableStringify(
      db.query("SELECT name, color FROM labels WHERE team_id IS NULL ORDER BY name").all(),
    ),
  );

  const projects = db
    .query(
      "SELECT id, name, description, state, lead_id, target_date, archived_at FROM projects ORDER BY name",
    )
    .all() as Array<Record<string, any>>;
  write(
    join(base, "meta", "projects.json"),
    stableStringify(
      projects.map((project) => ({
        name: project.name,
        description: project.description,
        state: project.state,
        lead: project.lead_id ? (lookups.actors.get(project.lead_id) ?? null) : null,
        targetDate: project.target_date,
        archived: Boolean(project.archived_at),
        teams: db
          .query(
            "SELECT teams.key FROM project_teams JOIN teams ON teams.id = project_teams.team_id WHERE project_id = ?1 ORDER BY teams.key",
          )
          .values(project.id)
          .map((row) => row[0]),
        milestones: db
          .query(
            "SELECT name, description, target_date AS targetDate, position FROM milestones WHERE project_id = ?1 ORDER BY position, name",
          )
          .all(project.id),
      })),
    ),
  );

  // A team-scoped export cannot safely carry workspace/personal views: their
  // filters may reference entities from teams that are absent from the export.
  // Keep only views owned by the selected team so --allow-partial remains a
  // deliberate, self-contained replacement instead of a late unknown-reference error.
  const savedViews = db
    .query(
      `SELECT sv.*, owners.name AS owner_name, teams.key AS team_key
       FROM saved_views sv
       JOIN actors owners ON owners.id = sv.owner_id
       LEFT JOIN teams ON teams.id = sv.team_id
       ${teamFilter ? "WHERE sv.team_id = ?1" : ""}
       ORDER BY sv.created_at, sv.id`,
    )
    .all(...((teamFilter ? [teamFilter.id] : []) as never[])) as Array<Record<string, any>>;
  const savedViewLookups = savedViews.length
    ? buildSavedViewLookups(db, lookups, context.teamKeys, context.identifiers, savedViews)
    : null;
  const resolveSavedViewRef = (table: SavedViewRefTable, value: string): string | undefined =>
    savedViewLookups?.[table].get(value);
  write(
    join(base, "meta", "saved-views.json"),
    stableStringify(
      savedViews.map((view) => ({
        name: view.name,
        scope: view.scope,
        team: view.team_key ?? null,
        owner: view.owner_name,
        filter: translateSavedViewFilter(
          JSON.parse(view.filter_json),
          resolveSavedViewRef,
          "toNaturalKeys",
          `Saved view "${view.name}"`,
        ),
        orderBy: view.order_by,
        groupBy: view.group_by,
        columns: JSON.parse(view.columns_json || "[]"),
        archived: Boolean(view.archived_at),
      })),
    ),
  );

  const favoriteRows = db
    .query(
      `SELECT f.*, actors.name AS actor_name,
              projects.name AS project_name,
              sv.name AS saved_view_name, sv.scope AS saved_view_scope,
              sv_owners.name AS saved_view_owner, sv_teams.key AS saved_view_team
       FROM favorites f
       JOIN actors ON actors.id = f.actor_id
       LEFT JOIN projects ON projects.id = f.project_id
       LEFT JOIN saved_views sv ON sv.id = f.saved_view_id
       LEFT JOIN actors sv_owners ON sv_owners.id = sv.owner_id
       LEFT JOIN teams sv_teams ON sv_teams.id = sv.team_id
       ${teamFilter ? "WHERE f.project_id IS NOT NULL OR sv.team_id = ?1" : ""}
       ORDER BY actors.name, f.position, f.created_at, f.id`,
    )
    .all(...((teamFilter ? [teamFilter.id] : []) as never[])) as Array<Record<string, any>>;
  for (const favorite of favoriteRows) {
    if (!favorite.project_name) continue;
    const count = db
      .query("SELECT count(*) AS count FROM projects WHERE name = ?1")
      .get(favorite.project_name) as { count: number };
    if (count.count > 1) {
      throw new Error(
        `Cannot export favorites: ambiguous project reference "${favorite.project_name}"`,
      );
    }
  }
  write(
    join(base, "meta", "favorites.json"),
    stableStringify(
      favoriteRows.map((favorite) => ({
        actor: favorite.actor_name,
        project: favorite.project_name ?? null,
        savedView: favorite.saved_view_id
          ? {
              name: favorite.saved_view_name,
              scope: favorite.saved_view_scope,
              team: favorite.saved_view_team ?? null,
              owner: favorite.saved_view_owner,
            }
          : null,
        position: favorite.position,
      })),
    ),
  );

  const cycles = db
    .query(
      `SELECT c.*, teams.key AS team_key
       FROM cycles c JOIN teams ON teams.id = c.team_id
       ORDER BY teams.key, c.number`,
    )
    .all() as Array<Record<string, any>>;
  write(
    join(base, "meta", "cycles.json"),
    stableStringify(
      cycles.map((cycle) => ({
        team: cycle.team_key,
        number: cycle.number,
        name: cycle.name,
        startsAt: cycle.starts_at,
        endsAt: cycle.ends_at,
        state: cycle.state,
        archived: Boolean(cycle.archived_at),
      })),
    ),
  );

  const projectUpdates = db
    .query(
      `SELECT pu.*, p.name AS project_name, a.name AS author_name
       FROM project_updates pu
       JOIN projects p ON p.id = pu.project_id
       JOIN actors a ON a.id = pu.author_id
       ORDER BY pu.created_at, pu.id`,
    )
    .all() as Array<Record<string, any>>;
  write(
    join(base, "meta", "project-updates.json"),
    stableStringify(
      projectUpdates.map((update) => ({
        project: update.project_name,
        author: update.author_name,
        health: update.health,
        body: update.body,
        risks: update.risks,
        createdAt: update.created_at,
      })),
    ),
  );

  // Iniciativas (PRB-216): por nombre de proyecto + dueño.
  const initiatives = db
    .query(
      `SELECT i.*, owners.name AS owner_name
       FROM initiatives i
       LEFT JOIN actors owners ON owners.id = i.owner_id
       ORDER BY i.created_at, i.id`,
    )
    .all() as Array<Record<string, any>>;
  write(
    join(base, "meta", "initiatives.json"),
    stableStringify(
      initiatives.map((initiative) => ({
        name: initiative.name,
        description: initiative.description,
        state: initiative.state,
        targetDate: initiative.target_date,
        owner: initiative.owner_name ?? null,
        archived: Boolean(initiative.archived_at),
        projects: db
          .query(
            `SELECT p.name FROM initiative_projects ip
             JOIN projects p ON p.id = ip.project_id
             WHERE ip.initiative_id = ?1
             ORDER BY p.name`,
          )
          .values(initiative.id)
          .map((row) => row[0] as string),
        teams: db
          .query(
            `SELECT t.key FROM initiative_teams it
             JOIN teams t ON t.id = it.team_id
             WHERE it.initiative_id = ?1
             ORDER BY t.key`,
          )
          .values(initiative.id)
          .map((row) => row[0] as string),
      })),
    ),
  );

  // Reviews (PRB-216): referencian issues por identifier legible.
  const reviews = db
    .query(
      `SELECT r.*,
              teams.key AS team_key, issues.number AS issue_number,
              req.name AS requester_name, rev.name AS reviewer_name
       FROM reviews r
       JOIN issues ON issues.id = r.issue_id
       JOIN teams ON teams.id = issues.team_id
       JOIN actors req ON req.id = r.requester_id
       JOIN actors rev ON rev.id = r.reviewer_id
       ORDER BY r.created_at, r.id`,
    )
    .all() as Array<Record<string, any>>;
  write(
    join(base, "meta", "reviews.json"),
    stableStringify(
      reviews.map((review) => ({
        issue: `${review.team_key}-${review.issue_number}`,
        requester: review.requester_name,
        reviewer: review.reviewer_name,
        status: review.status,
        createdAt: review.created_at,
        updatedAt: review.updated_at,
      })),
    ),
  );

  // Inbox receipts (PRB-224): activity_id es UUID regenerado en rebuild; se ancla
  // al índice del evento en el log del issue (mismo orden que export/import).
  const inboxReceipts = db
    .query(
      `SELECT teams.key AS team_key, issues.number AS issue_number,
              actors.name AS actor_name, r.read_at, r.archived_at,
              a.id AS activity_id
       FROM inbox_receipts r
       JOIN activity a ON a.id = r.activity_id
       JOIN issues ON issues.id = a.issue_id
       JOIN teams ON teams.id = issues.team_id
       JOIN actors ON actors.id = r.actor_id
       ORDER BY teams.key, issues.number, actors.name, a.created_at, a.id`,
    )
    .all() as Array<Record<string, any>>;
  const activityIndexByIssue = new Map<string, Map<string, number>>();
  for (const issue of db
    .query(
      `SELECT issues.id, teams.key || '-' || issues.number AS ident FROM issues
       JOIN teams ON teams.id = issues.team_id`,
    )
    .all() as Array<{ id: string; ident: string }>) {
    const events = db
      .query("SELECT id FROM activity WHERE issue_id = ?1 ORDER BY created_at, id")
      .all(issue.id) as Array<{ id: string }>;
    const index = new Map<string, number>();
    events.forEach((event, i) => index.set(event.id, i));
    activityIndexByIssue.set(issue.ident, index);
  }
  write(
    join(base, "meta", "inbox-receipts.json"),
    stableStringify(
      inboxReceipts.map((receipt) => {
        const issue = `${receipt.team_key}-${receipt.issue_number}`;
        return {
          issue,
          actor: receipt.actor_name,
          activityIndex: activityIndexByIssue.get(issue)?.get(receipt.activity_id) ?? 0,
          readAt: receipt.read_at,
          archivedAt: receipt.archived_at,
        };
      }),
    ),
  );

  // ---- issues: snapshot + log ----
  const issues = db
    .query(
      `SELECT issues.*, teams.key AS team_key FROM issues JOIN teams ON teams.id = issues.team_id
       ${teamFilter ? "WHERE issues.team_id = ?1" : ""}
       ORDER BY teams.key, issues.number`,
    )
    .all(...((teamFilter ? [teamFilter.id] : []) as never[])) as Array<Record<string, any>>;

  let events = 0;
  for (const issue of issues) {
    events += writeIssue(db, base, issue, context, write);
  }

  // Barrido: lo que quedó en el repo y ya no se exportó, se elimina.
  for (const folder of ["meta", "issues", "log"]) {
    const dir = join(base, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      // La trazabilidad de una migración es metadata de origen, no una proyección
      // de SQLite: el export normal no debe borrarla (AT-187).
      if (folder === "meta" && ["source-map.json", "migration-report.json"].includes(file))
        continue;
      const path = join(dir, file);
      if (!written.has(path)) unlinkSync(path);
    }
  }

  return { issues: issues.length, events, files };
}

/** Exporta un solo issue (AT-166): el camino caliente de cada mutación. */
export function exportIssue(db: Database, rootDir: string, issueId: string): boolean {
  const base = join(rootDir, ".prime-board");
  const issue = db
    .query(
      "SELECT issues.*, teams.key AS team_key FROM issues JOIN teams ON teams.id = issues.team_id WHERE issues.id = ?1",
    )
    .get(issueId) as Record<string, any> | null;
  if (!issue) return false;
  mkdirSync(join(base, "issues"), { recursive: true });
  mkdirSync(join(base, "log"), { recursive: true });
  writeIssue(
    db,
    base,
    issue,
    buildContext(db),
    makeWriter(() => {}),
  );
  return true;
}
