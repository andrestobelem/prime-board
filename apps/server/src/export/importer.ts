// Reconstrucción de la DB desde el repo (AT-157, Fase 2).
//
// La DB pasa a ser un índice derivado: se puede borrar y regenerar desde
// `.prime-board/`. Lo único que NO está en el repo son las credenciales
// (API keys y secrets de webhooks), así que se preservan re-vinculándolas
// por nombre de actor — de lo contrario un rebuild dejaría a todos afuera.
import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { newId, now } from "../db/util.ts";
import { translateActivityRefs, type RefTable } from "../domain/activity-schema.ts";

export interface RebuildResult {
  issues: number;
  events: number;
  comments: number;
  preservedKeys: number;
}

export interface RebuildOptions {
  /** Permite reemplazar el índice con un export team-scoped explícito. */
  allowPartial?: boolean;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Lee un issue en markdown: front-matter YAML + `# título` + descripción. */
function readIssueMarkdown(path: string): Record<string, any> {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`Invalid issue file (missing front matter): ${path}`);
  const meta = parseYaml(match[1]!) as Record<string, any>;
  // El cuerpo arranca con el `# título`; la descripción es lo que sigue.
  // PRB-222: la línea "Created by …" es decoración del snapshot, no descripción.
  const body = match[2]!
    .replace(/^\s*#[^\n]*\n?/, "")
    .replace(/^\s*Created by .+\.\n?/, "")
    .trim();
  return { ...meta, description: body.length > 0 ? body : null };
}

export function rebuildFromRepo(
  db: Database,
  rootDir: string,
  options: RebuildOptions = {},
): RebuildResult {
  const base = join(rootDir, ".prime-board");
  if (!existsSync(base)) throw new Error(`No .prime-board directory in ${rootDir}`);

  // La metadata del export se valida antes de leer credenciales o abrir la
  // transacción destructiva (PRB-237). Los repos antiguos sin este archivo se
  // tratan como exports completos por compatibilidad.
  const exportPath = join(base, "meta", "export.json");
  if (existsSync(exportPath)) {
    let scope: unknown;
    try {
      scope = readJson(exportPath).scope;
    } catch (error) {
      throw new Error(
        `Invalid meta/export.json: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (scope === "workspace") {
      // Alcance completo: permitido por defecto.
    } else if (typeof scope === "string" && /^team:[A-Z][A-Z0-9]{0,7}$/.test(scope)) {
      if (!options.allowPartial) {
        throw new Error(
          `Refusing partial export (${scope}); rerun with --allow-partial to replace the index explicitly`,
        );
      }
    } else {
      throw new Error(`Invalid export scope: ${String(scope)}`);
    }
  }

  // 1. Credenciales locales: se guardan por NOMBRE de actor porque los ids cambian.
  const keys = db
    .query(
      "SELECT api_keys.name, api_keys.hash, api_keys.last_used_at, api_keys.created_at, actors.name AS actor_name " +
        "FROM api_keys JOIN actors ON actors.id = api_keys.actor_id",
    )
    .all() as Array<Record<string, string | null>>;
  const webhooks = db.query("SELECT * FROM webhooks").all() as Array<Record<string, unknown>>;

  const result: RebuildResult = { issues: 0, events: 0, comments: 0, preservedKeys: 0 };

  db.transaction(() => {
    // `teams.default_state_id` apunta a workflow_states; limpiar la referencia
    // antes de borrar los estados permite reconstruir un índice ya poblado con
    // foreign keys activadas.
    db.query("UPDATE teams SET default_state_id = NULL").run();
    // 2. Vaciar el índice (orden inverso a las FKs).
    for (const table of [
      "issue_relations",
      "issue_labels",
      "activity",
      "comments",
      "reviews",
      "project_updates",
      "inbox_receipts",
      "api_keys",
      "webhooks",
      "issues",
      "cycles",
      "saved_views",
      "initiative_teams",
      "initiative_projects",
      "initiatives",
      "milestones",
      "project_teams",
      "projects",
      "labels",
      "workflow_states",
      "team_memberships",
      "teams",
      "actors",
      "workspace",
    ]) {
      db.query(`DELETE FROM ${table}`).run();
    }

    const timestamp = now();
    // 3. Workspace y actores.
    const workspace = readJson(join(base, "meta", "workspace.json"));
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    ).run(newId(), workspace.name ?? "Prime Board", workspace.urlKey ?? "prime-board", timestamp);

    const actorIds = new Map<string, string>();
    for (const actor of readJson(join(base, "meta", "actors.json")) as Array<
      Record<string, string | null>
    >) {
      const id = newId();
      actorIds.set(actor.name!, id);
      const workspaceRole =
        actor.workspaceRole ?? (actor.name?.toLowerCase() === "admin" ? "admin" : "member");
      if (workspaceRole !== "admin" && workspaceRole !== "member") {
        throw new Error(`Invalid workspace role for actor ${actor.name}: ${workspaceRole}`);
      }
      db.query(
        "INSERT INTO actors (id, name, email, type, workspace_role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      ).run(
        id,
        actor.name as string,
        actor.email ?? null,
        actor.type as string,
        workspaceRole,
        timestamp,
      );
    }

    // 4. Teams, estados y labels (clave: team key + nombre).
    const teamIds = new Map<string, string>();
    const stateIds = new Map<string, string>();
    const labelIds = new Map<string, string>();
    const legacyLabelIds = new Map<string, Array<{ id: string; team: string | null }>>();
    const addLegacyLabel = (name: string, id: string, team: string | null) => {
      const entries = legacyLabelIds.get(name) ?? [];
      entries.push({ id, team });
      legacyLabelIds.set(name, entries);
    };
    for (const team of readJson(join(base, "meta", "teams.json")) as Array<Record<string, any>>) {
      const teamId = newId();
      teamIds.set(team.key, teamId);
      db.query(
        "INSERT INTO teams (id, name, key, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).run(teamId, team.name, team.key, team.description ?? null, timestamp);
      for (const state of team.states ?? []) {
        const stateId = newId();
        stateIds.set(`${team.key}/${state.name}`, stateId);
        db.query(
          "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        ).run(stateId, teamId, state.name, state.type, state.color, state.position, timestamp);
      }
      for (const label of team.labels ?? []) {
        const labelId = newId();
        labelIds.set(`${team.key}/${label.name}`, labelId);
        addLegacyLabel(label.name, labelId, team.key);
        db.query(
          "INSERT INTO labels (id, name, color, team_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).run(labelId, label.name, label.color, teamId, timestamp);
      }
      // Estado default explícito (AT-180); exports viejos sin el campo caen al
      // primero por posición (los estados vienen ordenados así en el export).
      const defaultState = team.defaultState
        ? (stateIds.get(`${team.key}/${team.defaultState}`) ?? null)
        : null;
      const firstState = team.states?.[0]
        ? (stateIds.get(`${team.key}/${team.states[0].name}`) ?? null)
        : null;
      db.query("UPDATE teams SET default_state_id = ?1 WHERE id = ?2").run(
        defaultState ?? firstState,
        teamId,
      );

      const members = Array.isArray(team.members)
        ? team.members
        : Array.from(actorIds.keys()).map((actor) => ({ actor, role: "owner" }));
      for (const member of members as Array<Record<string, any>>) {
        const actorId = actorIds.get(member.actor);
        if (!actorId)
          throw new Error(`Team "${team.key}" references unknown actor ${member.actor}`);
        db.query(
          "INSERT INTO team_memberships (id, team_id, actor_id, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).run(newId(), teamId, actorId, member.role ?? "member", timestamp);
      }
    }
    for (const label of readJson(join(base, "meta", "workspace-labels.json")) as Array<
      Record<string, string>
    >) {
      const labelId = newId();
      labelIds.set(`workspace/${label.name}`, labelId);
      addLegacyLabel(label.name!, labelId, null);
      db.query(
        "INSERT INTO labels (id, name, color, team_id, created_at) VALUES (?1, ?2, ?3, NULL, ?4)",
      ).run(labelId, label.name as string, label.color as string, timestamp);
    }

    // 5. Proyectos y milestones.
    const projectIds = new Map<string, string>();
    const milestoneIds = new Map<string, string>();
    for (const project of readJson(join(base, "meta", "projects.json")) as Array<
      Record<string, any>
    >) {
      const projectId = newId();
      projectIds.set(project.name, projectId);
      db.query(
        `INSERT INTO projects (id, name, description, state, lead_id, target_date, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
      ).run(
        projectId,
        project.name,
        project.description ?? null,
        project.state,
        project.lead ? (actorIds.get(project.lead) ?? null) : null,
        project.targetDate ?? null,
        timestamp,
        project.archived ? timestamp : null,
      );
      for (const teamKey of project.teams ?? []) {
        const teamId = teamIds.get(teamKey);
        if (teamId) {
          db.query("INSERT INTO project_teams (project_id, team_id) VALUES (?1, ?2)").run(
            projectId,
            teamId,
          );
        }
      }
      for (const milestone of project.milestones ?? []) {
        const milestoneId = newId();
        milestoneIds.set(`${project.name}/${milestone.name}`, milestoneId);
        db.query(
          `INSERT INTO milestones (id, project_id, name, description, target_date, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
        ).run(
          milestoneId,
          projectId,
          milestone.name,
          milestone.description ?? null,
          milestone.targetDate ?? null,
          milestone.position ?? 0,
          timestamp,
        );
      }
    }

    // 5b. Vistas guardadas (PRB-209); ausente en exports viejos.
    const savedViewsPath = join(base, "meta", "saved-views.json");
    if (existsSync(savedViewsPath)) {
      for (const view of readJson(savedViewsPath) as Array<Record<string, any>>) {
        const ownerId = actorIds.get(view.owner);
        if (!ownerId)
          throw new Error(`Saved view "${view.name}" references unknown owner ${view.owner}`);
        let teamId: string | null = null;
        if (view.scope === "team") {
          if (!view.team) throw new Error(`Team saved view "${view.name}" missing team key`);
          teamId = teamIds.get(view.team) ?? null;
          if (!teamId)
            throw new Error(`Saved view "${view.name}" references unknown team ${view.team}`);
        }
        db.query(
          `INSERT INTO saved_views
            (id, name, scope, team_id, owner_id, filter_json, order_by, group_by, columns_json, created_at, updated_at, archived_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)`,
        ).run(
          newId(),
          view.name,
          view.scope,
          teamId,
          ownerId,
          JSON.stringify(view.filter ?? {}),
          view.orderBy ?? "CREATED_DESC",
          view.groupBy ?? "state",
          JSON.stringify(view.columns ?? []),
          timestamp,
          view.archived ? timestamp : null,
        );
      }
    }

    // 5c. Ciclos (PRB-211); ausente en exports viejos.
    const cyclesPath = join(base, "meta", "cycles.json");
    const cycleIds = new Map<string, string>();
    if (existsSync(cyclesPath)) {
      for (const cycle of readJson(cyclesPath) as Array<Record<string, any>>) {
        const teamId = teamIds.get(cycle.team);
        if (!teamId) throw new Error(`Cycle "${cycle.name}" references unknown team ${cycle.team}`);
        const id = newId();
        cycleIds.set(`${cycle.team}/${cycle.number}`, id);
        db.query(
          `INSERT INTO cycles
            (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at, archived_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
        ).run(
          id,
          teamId,
          cycle.number,
          cycle.name,
          cycle.startsAt,
          cycle.endsAt,
          cycle.state,
          timestamp,
          cycle.archived ? timestamp : null,
        );
      }
    }

    // 5d. Project updates (PRB-214); ausente en exports viejos.
    const projectUpdatesPath = join(base, "meta", "project-updates.json");
    if (existsSync(projectUpdatesPath)) {
      for (const update of readJson(projectUpdatesPath) as Array<Record<string, any>>) {
        const projectId = projectIds.get(update.project);
        if (!projectId) {
          throw new Error(`Project update references unknown project ${update.project}`);
        }
        const authorId = actorIds.get(update.author);
        if (!authorId) {
          throw new Error(`Project update references unknown author ${update.author}`);
        }
        db.query(
          `INSERT INTO project_updates
            (id, project_id, author_id, health, body, risks, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
        ).run(
          newId(),
          projectId,
          authorId,
          update.health,
          update.body,
          update.risks ?? null,
          update.createdAt ?? timestamp,
        );
      }
    }

    // 5e. Iniciativas (PRB-216); ausente en exports viejos.
    const initiativesPath = join(base, "meta", "initiatives.json");
    if (existsSync(initiativesPath)) {
      for (const initiative of readJson(initiativesPath) as Array<Record<string, any>>) {
        const ownerId = initiative.owner ? (actorIds.get(initiative.owner) ?? null) : null;
        if (initiative.owner && !ownerId) {
          throw new Error(
            `Initiative "${initiative.name}" references unknown owner ${initiative.owner}`,
          );
        }
        const id = newId();
        db.query(
          `INSERT INTO initiatives
            (id, name, description, state, target_date, owner_id, created_at, updated_at, archived_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
        ).run(
          id,
          initiative.name,
          initiative.description ?? null,
          initiative.state,
          initiative.targetDate ?? null,
          ownerId,
          timestamp,
          initiative.archived ? timestamp : null,
        );
        for (const projectName of initiative.projects ?? []) {
          const projectId = projectIds.get(projectName);
          if (!projectId) {
            throw new Error(
              `Initiative "${initiative.name}" references unknown project ${projectName}`,
            );
          }
          db.query(
            "INSERT INTO initiative_projects (initiative_id, project_id) VALUES (?1, ?2)",
          ).run(id, projectId);
        }
        for (const teamKey of initiative.teams ?? []) {
          const teamId = teamIds.get(teamKey);
          if (!teamId) {
            throw new Error(`Initiative "${initiative.name}" references unknown team ${teamKey}`);
          }
          db.query("INSERT INTO initiative_teams (initiative_id, team_id) VALUES (?1, ?2)").run(
            id,
            teamId,
          );
        }
      }
    }

    const resolveLabelId = (reference: unknown, issue: Record<string, any>): string => {
      if (typeof reference === "object" && reference !== null) {
        const label = reference as { name?: unknown; team?: unknown };
        if (typeof label.name !== "string") {
          throw new Error(`Invalid label reference on ${issue.id}`);
        }
        const key = label.team ? `${String(label.team)}/${label.name}` : `workspace/${label.name}`;
        const id = labelIds.get(key);
        if (!id) throw new Error(`Issue ${issue.id} references unknown label ${key}`);
        return id;
      }
      if (typeof reference !== "string") {
        throw new Error(`Invalid label reference on ${issue.id}`);
      }
      const qualified = labelIds.get(reference);
      if (qualified) return qualified;

      // Compatibility with old exports that stored only the label name. It is
      // safe only when the old name resolves to exactly one applicable scope.
      const candidates = (legacyLabelIds.get(reference) ?? []).filter(
        (candidate) => candidate.team === null || candidate.team === issue.team,
      );
      if (candidates.length === 1) return candidates[0]!.id;
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous label "${reference}" on ${issue.id}; export it with its team or workspace scope`,
        );
      }
      if ((legacyLabelIds.get(reference) ?? []).length > 0) {
        throw new Error(`Label "${reference}" does not belong to issue team ${issue.team}`);
      }
      throw new Error(`Issue ${issue.id} references unknown label ${reference}`);
    };

    // 6. Issues: primera pasada sin parent (se resuelve después).
    const issueIds = new Map<string, string>();
    const snapshots = readdirSync(join(base, "issues"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => readIssueMarkdown(join(base, "issues", file)))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    for (const issue of snapshots) {
      const [teamKey, numberText] = String(issue.id).split("-");
      const teamId = teamIds.get(teamKey!);
      if (!teamId) throw new Error(`Issue ${issue.id} references unknown team ${teamKey}`);
      let cycleId: string | null = null;
      if (issue.cycle) {
        cycleId = cycleIds.get(String(issue.cycle)) ?? null;
        if (!cycleId) throw new Error(`Issue ${issue.id} references unknown cycle ${issue.cycle}`);
      }
      const stateId = stateIds.get(`${teamKey}/${issue.state}`);
      if (!stateId) throw new Error(`Issue ${issue.id} references unknown state ${issue.state}`);
      const id = newId();
      issueIds.set(issue.id, id);
      db.query(
        `INSERT INTO issues (id, team_id, number, title, description, state_id, priority, assignee_id,
           parent_id, project_id, milestone_id, cycle_id, creator_id, sort_order, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      ).run(
        id,
        teamId,
        Number(numberText),
        issue.title,
        issue.description ?? null,
        stateId,
        issue.priority ?? 0,
        issue.assignee ? (actorIds.get(issue.assignee) ?? null) : null,
        issue.project ? (projectIds.get(issue.project) ?? null) : null,
        issue.milestone && issue.project
          ? (milestoneIds.get(
              issue.milestone.startsWith(`${issue.project}/`)
                ? issue.milestone
                : `${issue.project}/${issue.milestone}`,
            ) ?? null)
          : null,
        cycleId,
        actorIds.get(issue.creator) ?? [...actorIds.values()][0]!,
        typeof issue.sortOrder === "number" ? issue.sortOrder : 0,
        issue.createdAt,
        issue.updatedAt ?? issue.createdAt,
        issue.archivedAt ?? null,
      );
      for (const labelReference of issue.labels ?? []) {
        const labelId = resolveLabelId(labelReference, issue);
        db.query("INSERT INTO issue_labels (issue_id, label_id) VALUES (?1, ?2)").run(id, labelId);
      }
      result.issues += 1;
    }

    // 7. Segunda pasada: parents y relaciones (necesitan todos los issues creados).
    for (const issue of snapshots) {
      if (!issue.parent) continue;
      const child = issueIds.get(issue.id);
      const parent = issueIds.get(issue.parent);
      if (child && parent) {
        db.query("UPDATE issues SET parent_id = ?1 WHERE id = ?2").run(parent, child);
      }
    }
    for (const issue of snapshots) {
      const self = issueIds.get(issue.id)!;
      const insertRelation = (sourceId: string, targetId: string, type: string) =>
        db
          .query(
            "INSERT INTO issue_relations (id, issue_id, related_id, type, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
          )
          .run(newId(), sourceId, targetId, type, timestamp);
      // blockedBy en el snapshot === fila canónica blocks(bloqueante → bloqueado);
      // related y duplicateOf se listan en el extremo origen de la fila.
      for (const ref of issue.blockedBy ?? []) {
        const blocker = issueIds.get(ref);
        if (blocker) insertRelation(blocker, self, "blocks");
      }
      for (const ref of issue.related ?? []) {
        const other = issueIds.get(ref);
        if (other) insertRelation(self, other, "related");
      }
      for (const ref of issue.duplicateOf ?? []) {
        const canonical = issueIds.get(ref);
        if (canonical) insertRelation(self, canonical, "duplicate_of");
      }
    }

    // 7b. Reviews (PRB-216); requieren issues ya importados.
    const reviewsPath = join(base, "meta", "reviews.json");
    if (existsSync(reviewsPath)) {
      for (const review of readJson(reviewsPath) as Array<Record<string, any>>) {
        const issueId = issueIds.get(review.issue);
        if (!issueId) throw new Error(`Review references unknown issue ${review.issue}`);
        const requesterId = actorIds.get(review.requester);
        if (!requesterId) {
          throw new Error(
            `Review on ${review.issue} references unknown requester ${review.requester}`,
          );
        }
        const reviewerId = actorIds.get(review.reviewer);
        if (!reviewerId) {
          throw new Error(
            `Review on ${review.issue} references unknown reviewer ${review.reviewer}`,
          );
        }
        db.query(
          `INSERT INTO reviews
            (id, issue_id, requester_id, reviewer_id, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).run(
          newId(),
          issueId,
          requesterId,
          reviewerId,
          review.status,
          review.createdAt ?? timestamp,
          review.updatedAt ?? review.createdAt ?? timestamp,
        );
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

    // 9. Historial desde el log. El export guarda nombres; acá se resuelven de
    // nuevo a ids para que la DB quede igual que antes del rebuild (round-trip).
    // actorIds/projectIds/issueIds ya están indexados por clave natural.
    const byName = {
      actors: actorIds,
      projects: projectIds,
      issues: issueIds,
      states: new Map<string, string>(),
      milestones: new Map<string, string>(),
      cycles: cycleIds,
    };
    for (const [key, id] of stateIds) byName.states.set(key.split("/")[1]!, id);
    for (const [key, id] of milestoneIds) byName.milestones.set(key.split("/")[1]!, id);

    // Qué campos son referencia y a qué tabla vive en un solo lugar (AT-187):
    // acá solo se resuelve clave natural→id con los mapas que este import ya
    // construyó (byName + teamIds), en la dirección inversa a exporter.ts.
    const denormalize = (
      type: string,
      payload: Record<string, unknown>,
    ): Record<string, unknown> => {
      const resolve = (table: RefTable, value: string): string | undefined =>
        (
          ({
            states: byName.states,
            actors: byName.actors,
            projects: byName.projects,
            milestones: byName.milestones,
            cycles: byName.cycles,
            issues: byName.issues,
            teams: teamIds,
          }) satisfies Record<RefTable, Map<string, string>>
        )[table].get(value);
      return translateActivityRefs(type, payload, resolve, "toIds");
    };
    // activityIdsByIssue: índice estable para rehidratar inbox_receipts (PRB-224).
    const activityIdsByIssue = new Map<string, string[]>();

    // 9. Historial desde el log.
    for (const file of readdirSync(join(base, "log")).filter((f) => f.endsWith(".jsonl"))) {
      const identifier = file.replace(/\.jsonl$/, "");
      const issueId = issueIds.get(identifier);
      if (!issueId) continue;
      const activityIds: string[] = [];
      const contents = readFileSync(join(base, "log", file), "utf8").trim();
      if (!contents) continue;
      for (const line of contents.split("\n")) {
        const event = JSON.parse(line);
        const actorId = actorIds.get(event.actor) ?? [...actorIds.values()][0]!;
        // Los comentarios se reconstruyen desde el log: el evento `commented` ya
        // trae autor, fecha y body (AT-165), así que no se duplican en el snapshot.
        if (event.type === "commented" && event.payload?.body) {
          db.query(
            "INSERT INTO comments (id, issue_id, actor_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
          ).run(newId(), issueId, actorId, event.payload.body as string, event.ts as string);
          result.comments += 1;
        }
        const activityId = newId();
        activityIds.push(activityId);
        db.query(
          "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        ).run(
          activityId,
          issueId,
          actorId,
          event.type,
          JSON.stringify(denormalize(event.type, event.payload ?? {})),
          event.ts,
        );
        result.events += 1;
      }
      activityIdsByIssue.set(identifier, activityIds);
    }

    // 9b. Inbox receipts (PRB-224); ausente en exports viejos.
    const inboxReceiptsPath = join(base, "meta", "inbox-receipts.json");
    if (existsSync(inboxReceiptsPath)) {
      for (const receipt of readJson(inboxReceiptsPath) as Array<Record<string, any>>) {
        const actorId = actorIds.get(receipt.actor);
        if (!actorId) {
          throw new Error(`Inbox receipt references unknown actor ${receipt.actor}`);
        }
        const activityId = activityIdsByIssue.get(receipt.issue)?.[receipt.activityIndex];
        if (!activityId) {
          throw new Error(
            `Inbox receipt for ${receipt.issue} references missing activity index ${receipt.activityIndex}`,
          );
        }
        db.query(
          `INSERT INTO inbox_receipts (activity_id, actor_id, read_at, archived_at)
           VALUES (?1, ?2, ?3, ?4)`,
        ).run(activityId, actorId, receipt.readAt ?? null, receipt.archivedAt ?? null);
      }
    }

    // 10. Restaurar credenciales locales re-vinculando por nombre.
    for (const key of keys) {
      const actorId = actorIds.get(key.actor_name as string);
      if (!actorId) continue;
      db.query(
        "INSERT INTO api_keys (id, actor_id, name, hash, last_used_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run(
        newId(),
        actorId,
        key.name as string,
        key.hash as string,
        (key.last_used_at ?? null) as string | null,
        key.created_at as string,
      );
      result.preservedKeys += 1;
    }
    for (const hook of webhooks) {
      db.query(
        "INSERT INTO webhooks (id, url, secret, events, enabled, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run(
        hook.id as string,
        hook.url as string,
        hook.secret as string,
        hook.events as string,
        hook.enabled as number,
        hook.created_at as string,
      );
    }
  })();

  return result;
}
