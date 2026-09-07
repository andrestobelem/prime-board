// Reconstrucción de la DB desde el repo (AT-157, Fase 2).
//
// La DB pasa a ser un índice derivado: se puede borrar y regenerar desde
// `.prime-board/`. Lo único que NO está en el repo son las credenciales
// (API keys y secrets de webhooks), así que se preservan re-vinculándolas
// por nombre de actor — de lo contrario un rebuild dejaría a todos afuera.
import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_URL_KEY } from "../db/defaults.ts";
import { newId, now } from "../db/util.ts";
import { translateActivityRefs, type RefTable } from "../domain/activity-schema.ts";
import { translateSavedViewFilter, type SavedViewRefTable } from "./saved-view-filter.ts";
import { readReplicaMetadata, type ReadReplicaMetadata } from "./replica-metadata.ts";
import { readEventLog } from "./event-log.ts";
import { archiveDocumentSnapshot } from "./documents-archive.ts";
import { normalizeAvatarUrl } from "../domain/actors.ts";

export interface RebuildResult {
  issues: number;
  events: number;
  comments: number;
  preservedKeys: number;
  warnings: string[];
}

export interface RebuildOptions {
  /** Permite reemplazar el índice con un export team-scoped explícito. */
  allowPartial?: boolean;
  /** Archivo externo para archivar y verificar una captura histórica de Documents. */
  documentsArchivePath?: string;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/**
 * Puerta de seguridad de la fuente de rebuild. Una captura histórica no es una
 * entrada vigente del índice: se conserva en el repositorio, pero el operador
 * debe archivarla fuera de él antes de reconstruir una DB sin Documents.
 */
export function preflightRetiredDocuments(rootDir: string, documentsArchivePath?: string): void {
  const snapshotPath = join(rootDir, ".prime-board", "meta", "documents.json");
  if (!existsSync(snapshotPath)) return;
  const configured = documentsArchivePath ?? process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
  const trimmed = configured?.trim();
  if (!trimmed) {
    throw new Error(
      "Refusing rebuild: .prime-board/meta/documents.json is retired; provide PRIME_BOARD_DOCUMENTS_ARCHIVE after archiving it externally",
    );
  }
  // This is an explicit operator opt-in. Remove the source only after the
  // external bundle has been written and parsed back with its checksum.
  archiveDocumentSnapshot(snapshotPath, trimmed, "replica");
  unlinkSync(snapshotPath);
}

/**
 * Comprueba el destino antes de leer credenciales o ejecutar SQL destructivo.
 *
 * Hoy una DB tiene exactamente un Workspace operativo. Rechazar un destino que ya
 * tenga varios es intencional: protege vecinos futuros de un rebuild de toda la
 * base sin simular que esta versión puede operar dos Workspaces.
 */
function validateRebuildTarget(db: Database, metadata: ReadReplicaMetadata | null): void {
  const workspaces = db.query("SELECT id FROM workspace ORDER BY id").all() as Array<{
    id: string;
  }>;
  if (workspaces.length > 1) {
    throw new Error(
      "Cannot rebuild a multi-Workspace database: target scoping is reserved for a future topology",
    );
  }
  if (metadata?.workspaceId && workspaces[0] && workspaces[0].id !== metadata.workspaceId) {
    throw new Error(
      `Workspace metadata targets ${metadata.workspaceId}, but the operational Workspace is ${workspaces[0].id}`,
    );
  }
}

/** Validate the declared team scope before rebuild can clear the destination. */
function validatePartialScope(base: string, teamKey: string): void {
  const teams = readJson(join(base, "meta", "teams.json")) as Array<Record<string, any>>;
  if (teams.some((team) => team.key !== teamKey) || teams.length !== 1) {
    throw new Error(`Partial export team scope ${teamKey} contains out-of-scope teams`);
  }
  const projects = readJson(join(base, "meta", "projects.json")) as Array<Record<string, any>>;
  const projectNames = new Set(projects.map((project) => String(project.name)));
  if (projects.some((project) => !(project.teams ?? []).includes(teamKey))) {
    throw new Error(`Partial export ${teamKey} contains an out-of-scope project`);
  }
  const cyclesPath = join(base, "meta", "cycles.json");
  if (existsSync(cyclesPath)) {
    const cycles = readJson(cyclesPath) as Array<Record<string, any>>;
    if (cycles.some((cycle) => cycle.team !== teamKey)) {
      throw new Error(`Partial export ${teamKey} contains an out-of-scope cycle`);
    }
  }
  const updatesPath = join(base, "meta", "project-updates.json");
  if (existsSync(updatesPath)) {
    const updates = readJson(updatesPath) as Array<Record<string, any>>;
    if (updates.some((update) => !projectNames.has(String(update.project)))) {
      throw new Error(`Partial export ${teamKey} contains an out-of-scope project update`);
    }
  }
  const initiativesPath = join(base, "meta", "initiatives.json");
  if (existsSync(initiativesPath)) {
    const initiatives = readJson(initiativesPath) as Array<Record<string, any>>;
    for (const initiative of initiatives) {
      if ((initiative.teams ?? []).some((team: unknown) => team !== teamKey)) {
        throw new Error(`Partial export ${teamKey} contains an out-of-scope initiative team`);
      }
      if (
        (initiative.projects ?? []).some((project: unknown) => !projectNames.has(String(project)))
      ) {
        throw new Error(`Partial export ${teamKey} contains an out-of-scope initiative project`);
      }
    }
  }

  const issueIds = new Set(
    readdirSync(join(base, "issues"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(/\.md$/, "")),
  );
  if ([...issueIds].some((identifier) => !identifier.startsWith(`${teamKey}-`))) {
    throw new Error(`Partial export ${teamKey} contains an out-of-scope issue`);
  }
  const reviewsPath = join(base, "meta", "reviews.json");
  if (existsSync(reviewsPath)) {
    const reviews = readJson(reviewsPath) as Array<Record<string, any>>;
    if (reviews.some((review) => !String(review.issue).startsWith(`${teamKey}-`))) {
      throw new Error(`Partial export ${teamKey} contains an out-of-scope review`);
    }
  }
  const inboxPath = join(base, "meta", "inbox-receipts.json");
  if (existsSync(inboxPath)) {
    const receipts = readJson(inboxPath) as Array<Record<string, any>>;
    if (receipts.some((receipt) => !String(receipt.issue).startsWith(`${teamKey}-`))) {
      throw new Error(`Partial export ${teamKey} contains an out-of-scope inbox receipt`);
    }
  }
  const favoritesPath = join(base, "meta", "favorites.json");
  if (existsSync(favoritesPath)) {
    const savedViews = existsSync(join(base, "meta", "saved-views.json"))
      ? (readJson(join(base, "meta", "saved-views.json")) as Array<Record<string, any>>)
      : [];
    const savedViewKeys = new Set(
      savedViews
        .filter((view) => view.scope === "team" && view.team === teamKey)
        .map((view) =>
          savedViewNaturalKey({
            name: view.name,
            scope: view.scope,
            team: view.team ?? null,
            owner: view.owner,
          }),
        ),
    );
    const favorites = readJson(favoritesPath) as Array<Record<string, any>>;
    for (const favorite of favorites) {
      if (favorite.project != null && !projectNames.has(String(favorite.project))) {
        throw new Error(`Partial export ${teamKey} contains an out-of-scope favorite project`);
      }
      if (favorite.savedView != null) {
        const view = favorite.savedView as Record<string, any>;
        const key = savedViewNaturalKey({
          name: view.name,
          scope: view.scope,
          team: view.team ?? null,
          owner: view.owner,
        });
        if (!savedViewKeys.has(key)) {
          throw new Error(`Partial export ${teamKey} contains an out-of-scope favorite view`);
        }
      }
    }
  }
}

function savedViewNaturalKey(view: {
  name: string;
  scope: string;
  team: string | null;
  owner: string;
}): string {
  return JSON.stringify([view.scope, view.team, view.owner, view.name]);
}

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

function validateRepoIssueReferences(base: string, snapshots: Array<Record<string, any>>): void {
  const actors = readJson(join(base, "meta", "actors.json")) as unknown;
  if (!Array.isArray(actors)) throw new Error("Repo actors metadata must be an array");
  const actorNames = new Set<string>();
  for (const actor of actors) {
    if (!actor || typeof actor !== "object" || Array.isArray(actor))
      throw new Error("Repo actor metadata must be an object");
    const name = String(actor.name ?? "");
    if (!name || actorNames.has(name))
      throw new Error(`Ambiguous actor reference in repo: ${name}`);
    actorNames.add(name);
  }
  const teams = readJson(join(base, "meta", "teams.json")) as unknown;
  if (!Array.isArray(teams)) throw new Error("Repo teams metadata must be an array");
  const teamKeys = new Set<string>();
  const stateKeys = new Set<string>();
  const canceledStateByTeam = new Map<string, string>();
  const labelKeys = new Set<string>();
  for (const team of teams) {
    if (!team || typeof team !== "object" || Array.isArray(team))
      throw new Error("Repo team metadata must be an object");
    if (!Array.isArray(team.states) || (team.labels != null && !Array.isArray(team.labels)))
      throw new Error(
        `Repo team ${String(team.key ?? "")} must contain valid states and labels arrays`,
      );
    const key = String(team.key ?? "");
    if (!key || teamKeys.has(key)) throw new Error(`Ambiguous team reference in repo: ${key}`);
    teamKeys.add(key);
    const stateNames = new Set<string>();
    for (const state of Array.isArray(team.states) ? team.states : []) {
      const name = String(state.name ?? "");
      if (!name || stateNames.has(name))
        throw new Error(`Ambiguous state reference in repo: ${key}/${name}`);
      stateNames.add(name);
      stateKeys.add(`${key}/${name}`);
      if (state.type === "canceled") canceledStateByTeam.set(key, name);
    }
    if (team.defaultState != null && !stateNames.has(String(team.defaultState)))
      throw new Error(`Team ${key} references unknown default state ${team.defaultState}`);
    if (team.autoCloseState != null && !stateNames.has(String(team.autoCloseState)))
      throw new Error(`Team ${key} references unknown auto-close state ${team.autoCloseState}`);
    for (const label of Array.isArray(team.labels) ? team.labels : []) {
      const name = String(label.name ?? "");
      if (!name) throw new Error(`Team ${key} contains a label without a name`);
      const labelKey = `${key}/${name}`;
      if (labelKeys.has(labelKey))
        throw new Error(`Ambiguous label reference in repo: ${labelKey}`);
      labelKeys.add(labelKey);
    }
  }
  const workspaceLabels = readJson(join(base, "meta", "workspace-labels.json")) as unknown;
  if (!Array.isArray(workspaceLabels))
    throw new Error("Repo workspace labels metadata must be an array");
  for (const label of workspaceLabels) {
    if (!label || typeof label !== "object" || Array.isArray(label))
      throw new Error("Repo workspace label metadata must be an object");
    const name = String(label.name ?? "");
    if (!name) throw new Error("Workspace label is missing a name");
    const labelKey = `workspace/${name}`;
    if (labelKeys.has(labelKey)) throw new Error(`Ambiguous label reference in repo: ${labelKey}`);
    labelKeys.add(labelKey);
  }
  const projects = readJson(join(base, "meta", "projects.json")) as unknown;
  if (!Array.isArray(projects)) throw new Error("Repo projects metadata must be an array");
  const projectTeams = new Map<string, Set<string>>();
  const milestoneKeys = new Set<string>();
  for (const project of projects) {
    if (!project || typeof project !== "object" || Array.isArray(project))
      throw new Error("Repo project metadata must be an object");
    if (
      !Array.isArray(project.teams) ||
      (project.milestones != null && !Array.isArray(project.milestones))
    )
      throw new Error(
        `Repo project ${String(project.name ?? "")} must contain teams and milestones arrays`,
      );
    const name = String(project.name ?? "");
    if (!name) throw new Error("Project is missing a name");
    if (projectTeams.has(name)) throw new Error(`Ambiguous project reference in repo: ${name}`);
    if (project.lead != null && !actorNames.has(String(project.lead)))
      throw new Error(`Project ${name} references unknown lead ${String(project.lead)}`);
    const projectTeamReferences: string[] = (Array.isArray(project.teams) ? project.teams : []).map(
      (team: unknown) => String(team),
    );
    const teamsForProject = new Set<string>(projectTeamReferences);
    if (teamsForProject.size !== projectTeamReferences.length)
      throw new Error(`Project ${name} repeats a team reference`);
    if (teamsForProject.size === 0)
      throw new Error(`Project ${name} must belong to at least one team`);
    for (const team of teamsForProject)
      if (!teamKeys.has(team)) throw new Error(`Project ${name} references unknown team ${team}`);
    projectTeams.set(name, teamsForProject);
    const milestones = Array.isArray(project.milestones) ? project.milestones : [];
    const milestoneNames = new Set<string>();
    for (const milestone of milestones) {
      const milestoneName = String(milestone.name ?? "");
      if (!milestoneName || milestoneNames.has(milestoneName))
        throw new Error(`Ambiguous milestone reference in repo: ${name}/${milestoneName}`);
      milestoneNames.add(milestoneName);
      milestoneKeys.add(`${name}/${milestoneName}`);
    }
  }
  const issueById = new Map<string, Record<string, any>>();
  const issueIdentifiers = new Set<string>();
  for (const issue of snapshots) {
    const id = String(issue.id ?? "");
    if (!id) throw new Error("Issue is missing an id");
    if (issueById.has(id)) throw new Error(`Ambiguous issue reference in repo: ${id}`);
    const identifier = id;
    if (issueIdentifiers.has(identifier))
      throw new Error(`Duplicate issue reference in repo: ${identifier}`);
    issueIdentifiers.add(identifier);
    issueById.set(id, issue);
  }
  const parentGraph = new Map<string, Set<string>>();
  const blockGraph = new Map<string, Set<string>>();
  for (const issue of snapshots) {
    const id = String(issue.id ?? "");
    parentGraph.set(id, new Set());
    blockGraph.set(id, new Set());
  }
  for (const issue of snapshots) {
    const id = String(issue.id ?? "");
    const team = String(issue.team ?? "");
    if (!teamKeys.has(team)) throw new Error(`Issue ${id} references unknown team ${team}`);
    const creator = String(issue.creator ?? "");
    if (!actorNames.has(creator))
      throw new Error(`Issue ${id} references unknown creator ${creator}`);
    if (issue.assignee != null && !actorNames.has(String(issue.assignee)))
      throw new Error(`Issue ${id} references unknown assignee ${String(issue.assignee)}`);
    for (const subscriber of Array.isArray(issue.subscribers) ? issue.subscribers : [])
      if (!actorNames.has(String(subscriber)))
        throw new Error(`Issue ${id} references unknown subscriber ${String(subscriber)}`);
    if (issue.subscribers != null && !Array.isArray(issue.subscribers))
      throw new Error(`Issue ${id} field subscribers must be an array`);
    if (!stateKeys.has(`${team}/${String(issue.state ?? "")}`))
      throw new Error(`Issue ${id} references unknown state ${team}/${String(issue.state ?? "")}`);
    for (const field of ["blockedBy", "related", "duplicateOf"] as const) {
      if (issue[field] != null && !Array.isArray(issue[field]))
        throw new Error(`Issue ${id} field ${field} must be an array`);
    }
    if (issue.parent != null) {
      const parentId = String(issue.parent);
      const parent = issueById.get(parentId);
      if (!parent) throw new Error(`Issue ${id} references unknown parent ${parentId}`);
      if (String(parent.team) !== team)
        throw new Error(`Issue ${id} parent ${parentId} belongs to another team`);
      parentGraph.get(id)?.add(parentId);
    }
    if (issue.project != null) {
      const project = String(issue.project);
      if (!projectTeams.has(project))
        throw new Error(`Issue ${id} references unknown project ${project}`);
      if (!projectTeams.get(project)?.has(team))
        throw new Error(`Project ${project} does not include issue team ${team}`);
    }
    if (issue.milestone != null) {
      const milestone = String(issue.milestone);
      const qualified = milestone.includes("/")
        ? milestone
        : `${String(issue.project ?? "")}/${milestone}`;
      if (!issue.project) throw new Error(`Issue ${id} milestone requires a project`);
      if (!milestoneKeys.has(qualified))
        throw new Error(`Issue ${id} references unknown milestone ${qualified}`);
    }
    const issueLabelKeys = new Set<string>();
    for (const reference of Array.isArray(issue.labels) ? issue.labels : []) {
      let key: string;
      if (reference && typeof reference === "object") {
        const label = reference as { name?: unknown; team?: unknown };
        key = `${label.team ? String(label.team) : "workspace"}/${String(label.name ?? "")}`;
      } else {
        const value = String(reference);
        key = value.includes("/") ? value : `${team}/${value}`;
        if (!labelKeys.has(key) && !value.includes("/") && labelKeys.has(`workspace/${value}`))
          key = `workspace/${value}`;
      }
      if (!labelKeys.has(key)) throw new Error(`Issue ${id} references unknown label ${key}`);
      if (issueLabelKeys.has(key)) throw new Error(`Issue ${id} repeats label ${key}`);
      issueLabelKeys.add(key);
      const labelScope = key.split("/", 1)[0];
      if (labelScope !== "workspace" && labelScope !== team)
        throw new Error(`Issue ${id} label ${key} belongs to another team`);
    }
    for (const reference of Array.isArray(issue.blockedBy) ? issue.blockedBy : []) {
      const blocker = String(reference);
      if (!issueById.has(blocker))
        throw new Error(`Issue ${id} references unknown blocker ${blocker}`);
      if (blocker === id) throw new Error(`Issue ${id} cannot block itself`);
      blockGraph.get(blocker)?.add(id);
    }
    for (const field of ["related", "duplicateOf"] as const) {
      for (const reference of Array.isArray(issue[field]) ? issue[field] : []) {
        const related = String(reference);
        if (!issueById.has(related))
          throw new Error(`Issue ${id} references unknown related issue ${related}`);
        if (related === id) throw new Error(`Issue ${id} cannot relate to itself`);
      }
    }
    if (
      Array.isArray(issue.duplicateOf) &&
      issue.duplicateOf.length > 0 &&
      !canceledStateByTeam.has(team)
    )
      throw new Error(`Team ${team} has no canceled state for duplicate-of issue ${id}`);
  }
  const relationKeys = new Set<string>();
  for (const issue of snapshots) {
    const id = String(issue.id);
    for (const reference of Array.isArray(issue.related) ? issue.related : []) {
      const other = String(reference);
      const key = id < other ? `related:${id}:${other}` : `related:${other}:${id}`;
      if (relationKeys.has(key)) throw new Error(`Duplicate relation ${key}`);
      relationKeys.add(key);
    }
    for (const reference of Array.isArray(issue.duplicateOf) ? issue.duplicateOf : []) {
      const key = `duplicate_of:${id}:${String(reference)}`;
      if (relationKeys.has(key)) throw new Error(`Duplicate relation ${key}`);
      relationKeys.add(key);
    }
    for (const reference of Array.isArray(issue.blockedBy) ? issue.blockedBy : []) {
      const key = `blocks:${String(reference)}:${id}`;
      if (relationKeys.has(key)) throw new Error(`Duplicate relation ${key}`);
      relationKeys.add(key);
    }
  }
  const assertAcyclic = (graph: Map<string, Set<string>>, kind: string): void => {
    const active = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string): void => {
      if (active.has(node)) throw new Error(`${kind} contains a cycle at ${node}`);
      if (done.has(node)) return;
      active.add(node);
      for (const next of graph.get(node) ?? []) visit(next);
      active.delete(node);
      done.add(node);
    };
    for (const node of graph.keys()) visit(node);
  };
  assertAcyclic(parentGraph, "Parent relationships");
  assertAcyclic(blockGraph, "Blocking relations");
}

export function rebuildFromRepo(
  db: Database,
  rootDir: string,
  options: RebuildOptions = {},
): RebuildResult {
  const base = join(rootDir, ".prime-board");
  if (!existsSync(base)) throw new Error(`No .prime-board directory in ${rootDir}`);

  // La captura retirada se archiva (o se rechaza) antes de leer metadata,
  // credenciales o abrir la transacción destructiva.
  preflightRetiredDocuments(rootDir, options.documentsArchivePath);

  // La metadata del export se valida antes de leer credenciales o abrir la
  // transacción destructiva (PRB-237/403). Los repos antiguos sin este archivo
  // se tratan como exports completos por compatibilidad.
  const metadata = readReplicaMetadata(rootDir);
  const scope = metadata?.scope ?? "workspace";
  validateRebuildTarget(db, metadata);
  if (scope.startsWith("team:")) {
    if (!options.allowPartial) {
      throw new Error(
        `Refusing partial export (${scope}); rerun with --allow-partial to replace the index explicitly`,
      );
    }
    validatePartialScope(base, scope.slice("team:".length));
  }

  // Reject ambiguous project keys before opening the destructive transaction.
  // This is intentionally also checked for hand-edited snapshots, not only
  // exports produced by exporter.ts.
  const projectSnapshot = readJson(join(base, "meta", "projects.json")) as Array<
    Record<string, any>
  >;
  const seenProjectNames = new Set<string>();
  for (const project of projectSnapshot) {
    const name = String(project.name ?? "");
    if (seenProjectNames.has(name)) {
      throw new Error(`Ambiguous project reference in repo: ${name}`);
    }
    seenProjectNames.add(name);
  }

  // Valida también el snapshot del Workspace antes de entrar en la transacción
  // destructiva. Es opcional en el formato histórico de identidad, pero si está
  // presente debe coincidir con la metadata versionada de la réplica.
  const workspaceSnapshot = readJson(join(base, "meta", "workspace.json")) as Record<string, any>;
  if (
    metadata?.workspaceId &&
    workspaceSnapshot.id != null &&
    String(workspaceSnapshot.id) !== metadata.workspaceId
  ) {
    throw new Error(
      `Workspace metadata (${metadata.workspaceId}) does not match workspace snapshot (${workspaceSnapshot.id})`,
    );
  }
  const rebuiltWorkspaceId =
    metadata?.workspaceId ?? (workspaceSnapshot.id ? String(workspaceSnapshot.id) : newId());

  // 1. Credenciales locales. El id exportado es la identidad estable; el nombre
  // queda como fallback para repos antiguos que todavía no lo incluían.
  let keys = db
    .query(
      "SELECT api_keys.id, api_keys.actor_id, api_keys.name, api_keys.hash, api_keys.last_used_at, api_keys.revoked_at, api_keys.created_at, api_keys.expires_at, api_keys.rotated_from_id, actors.name AS actor_name " +
        "FROM api_keys JOIN actors ON actors.id = api_keys.actor_id",
    )
    .all() as Array<Record<string, string | null>>;
  // Los límites y scopes son metadata local de la credencial: se leen antes de
  // limpiar la base, pero nunca forman parte del export (y por tanto nunca
  // pueden filtrar hashes ni secretos).
  const keyScopes = new Map<string, string[]>();
  for (const row of db.query("SELECT api_key_id, scope FROM api_key_scopes").all() as Array<{
    api_key_id: string;
    scope: string;
  }>) {
    const keyId = row.api_key_id;
    const scope = row.scope;
    const current = keyScopes.get(keyId) ?? [];
    current.push(scope);
    keyScopes.set(keyId, current);
  }
  const keyTeamKeys = new Map<string, string[]>();
  for (const row of db
    .query(
      "SELECT api_key_id, teams.key AS team_key FROM api_key_team_limits JOIN teams ON teams.id = api_key_team_limits.team_id",
    )
    .all() as Array<{ api_key_id: string; team_key: string }>) {
    const keyId = row.api_key_id;
    const teamKey = row.team_key;
    const current = keyTeamKeys.get(keyId) ?? [];
    current.push(teamKey);
    keyTeamKeys.set(keyId, current);
  }
  const actors = readJson(join(base, "meta", "actors.json")) as Array<Record<string, any>>;
  const actorsBySourceId = new Map<string, Record<string, any>>();
  const actorsByName = new Map<string, Record<string, any>>();
  for (const actor of actors) {
    const name = String(actor.name ?? "");
    if (!name) throw new Error("Actor in repo is missing a name");
    if (actorsByName.has(name)) {
      throw new Error(`Ambiguous actor name in repo: ${name}`);
    }
    actorsByName.set(name, actor);
    if (actor.id != null) {
      const sourceId = String(actor.id);
      if (actorsBySourceId.has(sourceId)) {
        throw new Error(`Duplicate actor id in repo: ${sourceId}`);
      }
      actorsBySourceId.set(sourceId, actor);
    }
  }
  // El export del repo omite intencionalmente los hashes. Si esta DB no tiene una
  // copia local de una key, conserva su metadata no secreta como credencial redacted
  // inutilizable, para que el rebuild no ensanche scopes, expiración o rotación.
  const exportedKeysPath = join(base, "meta", "api-keys.json");
  if (existsSync(exportedKeysPath) && keys.length === 0) {
    const knownIds = new Set(keys.map((key) => String(key.id)));
    for (const metadataKey of readJson(exportedKeysPath) as Array<Record<string, any>>) {
      const sourceId = String(metadataKey.id ?? "");
      if (!sourceId || knownIds.has(sourceId)) continue;
      const actorId = metadataKey.actorId == null ? null : String(metadataKey.actorId);
      const actor = actorId
        ? actorsBySourceId.get(actorId)
        : actorsByName.get(String(metadataKey.actor ?? ""));
      if (!actor)
        throw new Error(
          `Cannot preserve API key ${metadataKey.name ?? "<unnamed>"}: actor disappeared`,
        );
      keys.push({
        id: sourceId,
        actor_id: actorId,
        actor_name: String(metadataKey.actor ?? actor.name),
        name: String(metadataKey.name ?? ""),
        hash: `redacted:${sourceId}`,
        last_used_at: metadataKey.lastUsedAt == null ? null : String(metadataKey.lastUsedAt),
        revoked_at: metadataKey.revokedAt == null ? null : String(metadataKey.revokedAt),
        created_at: String(metadataKey.createdAt ?? now()),
        expires_at: metadataKey.expiresAt == null ? null : String(metadataKey.expiresAt),
        rotated_from_id:
          metadataKey.rotatedFromId == null ? null : String(metadataKey.rotatedFromId),
      });
      keyScopes.set(
        sourceId,
        Array.isArray(metadataKey.scopes) ? metadataKey.scopes.map(String) : [],
      );
      keyTeamKeys.set(
        sourceId,
        Array.isArray(metadataKey.teamIds) ? metadataKey.teamIds.map(String) : [],
      );
    }
  }
  const keyTargets = keys.map((key) => {
    const actor =
      (key.actor_id ? actorsBySourceId.get(key.actor_id) : undefined) ??
      actorsByName.get(String(key.actor_name ?? ""));
    if (!actor) {
      throw new Error(
        `Cannot preserve API key ${key.name ?? "<unnamed>"} for actor ${key.actor_name ?? "<unknown>"}`,
      );
    }
    return { key, actor };
  });
  const webhooks = db
    .query(
      "SELECT webhooks.*, actors.name AS owner_name FROM webhooks LEFT JOIN actors ON actors.id = webhooks.owner_id",
    )
    .all() as Array<Record<string, unknown>>;

  const result: RebuildResult = {
    issues: 0,
    events: 0,
    comments: 0,
    preservedKeys: 0,
    warnings: [],
  };
  const snapshots = readdirSync(join(base, "issues"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => readIssueMarkdown(join(base, "issues", file)))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  validateRepoIssueReferences(base, snapshots);

  db.transaction(() => {
    // `teams.default_state_id` apunta a workflow_states; limpiar la referencia
    // antes de borrar los estados permite reconstruir un índice ya poblado con
    // foreign keys activadas.
    db.query("UPDATE teams SET default_state_id = NULL").run();
    // 2. Vaciar el índice (orden inverso a las FKs).
    for (const table of [
      "issue_relations",
      "issue_subscribers",
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
      "favorites",
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
    // 3. Workspace y actores. La metadata v1 conserva la identidad estable;
    // exports históricos no la tenían y reciben un id nuevo como antes.
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    ).run(
      rebuiltWorkspaceId,
      workspaceSnapshot.name ?? DEFAULT_WORKSPACE_NAME,
      workspaceSnapshot.urlKey ?? DEFAULT_WORKSPACE_URL_KEY,
      timestamp,
    );

    const actorIds = new Map<string, string>();
    const actorIdsBySourceId = new Map<string, string>();
    for (const actor of actors) {
      const id = actor.id != null ? String(actor.id) : newId();
      actorIds.set(actor.name!, id);
      if (actor.id != null) actorIdsBySourceId.set(String(actor.id), id);
      const workspaceRole =
        actor.workspaceRole ?? (actor.name?.toLowerCase() === "admin" ? "admin" : "member");
      if (workspaceRole !== "admin" && workspaceRole !== "member") {
        throw new Error(`Invalid workspace role for actor ${actor.name}: ${workspaceRole}`);
      }
      const status = actor.status ?? "active";
      if (status !== "active" && status !== "suspended" && status !== "left") {
        throw new Error(`Invalid actor status for actor ${actor.name}: ${status}`);
      }
      db.query(
        "INSERT INTO actors (id, name, email, type, avatar_url, workspace_role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
      ).run(
        id,
        actor.name as string,
        actor.email ?? null,
        actor.type as string,
        normalizeAvatarUrl(actor.avatarUrl, null),
        workspaceRole,
        status,
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
    const teamColumns = new Set(
      (db.query("PRAGMA table_info(teams)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const stateColumns = new Set(
      (db.query("PRAGMA table_info(workflow_states)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    for (const team of readJson(join(base, "meta", "teams.json")) as Array<Record<string, any>>) {
      const teamId = newId();
      teamIds.set(team.key, teamId);
      const visibility = team.visibility === "private" ? "private" : "public";
      const accessPolicy =
        team.accessPolicy === "workspace_members" || team.accessPolicy === "team_members"
          ? team.accessPolicy
          : "team_members";
      const teamInsertColumns = [
        "id",
        "name",
        "key",
        "description",
        "visibility",
        "access_policy",
        ...(teamColumns.has("auto_close_period") ? ["auto_close_period"] : []),
        ...(teamColumns.has("auto_archive_period") ? ["auto_archive_period"] : []),
        ...(teamColumns.has("auto_close_parent_issues") ? ["auto_close_parent_issues"] : []),
        ...(teamColumns.has("auto_close_child_issues") ? ["auto_close_child_issues"] : []),
        "created_at",
        "updated_at",
        "archived_at",
      ];
      const teamInsertValues = [
        teamId,
        team.name,
        team.key,
        team.description ?? null,
        visibility,
        visibility === "private" ? "team_members" : accessPolicy,
        ...(teamColumns.has("auto_close_period")
          ? [
              typeof team.autoClosePeriod === "number" && team.autoClosePeriod > 0
                ? team.autoClosePeriod
                : null,
            ]
          : []),
        ...(teamColumns.has("auto_archive_period")
          ? [
              typeof team.autoArchivePeriod === "number" && team.autoArchivePeriod > 0
                ? team.autoArchivePeriod
                : null,
            ]
          : []),
        ...(teamColumns.has("auto_close_parent_issues")
          ? [
              typeof team.autoCloseParentIssues === "boolean"
                ? team.autoCloseParentIssues
                  ? 1
                  : 0
                : null,
            ]
          : []),
        ...(teamColumns.has("auto_close_child_issues")
          ? [
              typeof team.autoCloseChildIssues === "boolean"
                ? team.autoCloseChildIssues
                  ? 1
                  : 0
                : null,
            ]
          : []),
        timestamp,
        timestamp,
        team.archived ? timestamp : null,
      ];
      const teamPlaceholders = teamInsertValues.map((_, index) => `?${index + 1}`).join(", ");
      db.query(
        `INSERT INTO teams (${teamInsertColumns.join(", ")}) VALUES (${teamPlaceholders})`,
      ).run(...(teamInsertValues as never[]));
      for (const state of team.states ?? []) {
        const stateId = newId();
        stateIds.set(`${team.key}/${state.name}`, stateId);
        const stateInsertColumns = [
          "id",
          "team_id",
          "name",
          "type",
          "color",
          "position",
          ...(stateColumns.has("description") ? ["description"] : []),
          "created_at",
          "updated_at",
        ];
        const stateInsertValues = [
          stateId,
          teamId,
          state.name,
          state.type,
          state.color,
          state.position,
          ...(stateColumns.has("description") ? [state.description ?? null] : []),
          timestamp,
          timestamp,
        ];
        const statePlaceholders = stateInsertValues.map((_, index) => `?${index + 1}`).join(", ");
        db.query(
          `INSERT INTO workflow_states (${stateInsertColumns.join(", ")}) VALUES (${statePlaceholders})`,
        ).run(...(stateInsertValues as never[]));
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
      if (teamColumns.has("auto_close_state_id")) {
        const autoCloseState = team.autoCloseState
          ? (stateIds.get(`${team.key}/${String(team.autoCloseState)}`) ?? null)
          : null;
        db.query(
          "UPDATE teams SET default_state_id = ?1, auto_close_state_id = ?2 WHERE id = ?3",
        ).run(defaultState ?? firstState, autoCloseState, teamId);
      } else {
        db.query("UPDATE teams SET default_state_id = ?1 WHERE id = ?2").run(
          defaultState ?? firstState,
          teamId,
        );
      }

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
    const initiativeIds = new Map<string, string>();
    const ambiguousInitiatives = new Set<string>();
    if (existsSync(initiativesPath)) {
      for (const initiative of readJson(initiativesPath) as Array<Record<string, any>>) {
        const initiativeName = String(initiative.name);
        if (!ambiguousInitiatives.has(initiativeName) && initiativeIds.has(initiativeName)) {
          initiativeIds.delete(initiativeName);
          ambiguousInitiatives.add(initiativeName);
        }
        const ownerId = initiative.owner ? (actorIds.get(initiative.owner) ?? null) : null;
        if (initiative.owner && !ownerId) {
          throw new Error(
            `Initiative "${initiative.name}" references unknown owner ${initiative.owner}`,
          );
        }
        const id = newId();
        if (!ambiguousInitiatives.has(initiativeName)) initiativeIds.set(initiativeName, id);
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
      for (const subscriber of issue.subscribers ?? []) {
        const subscriberId = actorIds.get(String(subscriber));
        if (!subscriberId) {
          throw new Error(`Issue ${issue.id} references unknown subscriber ${subscriber}`);
        }
        db.query(
          `INSERT INTO issue_subscribers (issue_id, actor_id, created_at)
           VALUES (?1, ?2, ?3) ON CONFLICT(issue_id, actor_id) DO NOTHING`,
        ).run(id, subscriberId, issue.createdAt);
      }
      result.issues += 1;
    }

    // 6b. Vistas guardadas (PRB-209/244); se importan después de los issues
    // porque sus filtros también pueden referirlos por identifier.
    const savedViewIds = new Map<string, string>();
    const savedViewsPath = join(base, "meta", "saved-views.json");
    if (existsSync(savedViewsPath)) {
      const savedViewLookups: Record<SavedViewRefTable, Map<string, string>> = {
        teams: teamIds,
        states: stateIds,
        actors: actorIds,
        projects: projectIds,
        milestones: milestoneIds,
        labels: labelIds,
        issues: issueIds,
        cycles: cycleIds,
      };
      const resolveSavedViewRef = (table: SavedViewRefTable, value: string): string | undefined =>
        savedViewLookups[table].get(value);
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
        const filter = translateSavedViewFilter(
          view.filter ?? {},
          resolveSavedViewRef,
          "toIds",
          `Saved view "${view.name}"`,
        );
        const savedViewId = newId();
        db.query(
          `INSERT INTO saved_views
            (id, name, scope, team_id, owner_id, filter_json, order_by, group_by, columns_json, created_at, updated_at, archived_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)`,
        ).run(
          savedViewId,
          view.name,
          view.scope,
          teamId,
          ownerId,
          JSON.stringify(filter),
          view.orderBy ?? "CREATED_DESC",
          view.groupBy ?? "state",
          JSON.stringify(view.columns ?? []),
          timestamp,
          view.archived ? timestamp : null,
        );
        const key = savedViewNaturalKey({
          name: view.name,
          scope: view.scope,
          team: view.team ?? null,
          owner: view.owner,
        });
        if (savedViewIds.has(key)) throw new Error(`Duplicate saved view reference: ${key}`);
        savedViewIds.set(key, savedViewId);
      }
    }

    // 6c. Favoritos: se resuelven por claves naturales después de proyectos y vistas.
    const favoritesPath = join(base, "meta", "favorites.json");
    if (existsSync(favoritesPath)) {
      const favoriteTargets = new Set<string>();
      for (const favorite of readJson(favoritesPath) as Array<Record<string, any>>) {
        const actorId = actorIds.get(favorite.actor);
        if (!actorId) throw new Error(`Favorite references unknown actor ${favorite.actor}`);
        const project = favorite.project ?? null;
        const savedView = favorite.savedView ?? null;
        if ((project == null) === (savedView == null)) {
          throw new Error(`Favorite for actor ${favorite.actor} must reference exactly one target`);
        }
        const projectId = project != null ? (projectIds.get(project) ?? null) : null;
        if (project != null && !projectId) {
          throw new Error(`Favorite references unknown project ${project}`);
        }
        const savedViewId = savedView
          ? (savedViewIds.get(
              savedViewNaturalKey({
                name: savedView.name,
                scope: savedView.scope,
                team: savedView.team ?? null,
                owner: savedView.owner,
              }),
            ) ?? null)
          : null;
        if (savedView != null && !savedViewId) {
          throw new Error(`Favorite references unknown saved view ${savedView.name}`);
        }
        const targetKey = `${actorId}:${projectId ?? savedViewId}`;
        if (favoriteTargets.has(targetKey)) throw new Error(`Duplicate favorite: ${targetKey}`);
        favoriteTargets.add(targetKey);
        db.query(
          `INSERT INTO favorites (id, actor_id, project_id, saved_view_id, position, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).run(
          newId(),
          actorId,
          projectId,
          savedViewId,
          typeof favorite.position === "number" ? favorite.position : 0,
          timestamp,
        );
      }
    }

    // 7. Segunda pasada: parents y relaciones (necesitan todos los issues creados).
    const duplicateTransitions: Array<{
      identifier: string;
      issueId: string;
      actorId: string;
      fromStateId: string;
      toStateId: string;
      createdAt: string;
    }> = [];
    const duplicateRelationEvents: Array<{
      sourceIssueId: string;
      targetIssueId: string;
      sourceIdentifier: string;
      targetIdentifier: string;
      actorId: string;
      createdAt: string;
    }> = [];
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
        if (!canonical) continue;
        insertRelation(self, canonical, "duplicate_of");
        duplicateRelationEvents.push({
          sourceIssueId: self,
          targetIssueId: canonical,
          sourceIdentifier: issue.id,
          targetIdentifier: String(ref),
          actorId: actorIds.get(String(issue.creator)) ?? [...actorIds.values()][0]!,
          createdAt: timestamp,
        });
        const source = db.query("SELECT team_id, state_id FROM issues WHERE id = ?1").get(self) as {
          team_id: string;
          state_id: string;
        } | null;
        if (!source) throw new Error(`Duplicate issue ${issue.id} disappeared during rebuild`);
        const canceled = db
          .query(
            "SELECT id FROM workflow_states WHERE team_id = ?1 AND type = 'canceled' ORDER BY position, id LIMIT 1",
          )
          .get(source.team_id) as { id: string } | null;
        if (!canceled)
          throw new Error(
            `Team ${issue.team} has no canceled state for duplicate-of issue ${issue.id}`,
          );
        if (source.state_id !== canceled.id) {
          duplicateTransitions.push({
            identifier: issue.id,
            issueId: self,
            actorId: actorIds.get(String(issue.creator)) ?? [...actorIds.values()][0]!,
            fromStateId: source.state_id,
            toStateId: canceled.id,
            createdAt: String(issue.updatedAt ?? timestamp),
          });
          db.query("UPDATE issues SET state_id = ?1, updated_at = ?2 WHERE id = ?3").run(
            canceled.id,
            String(issue.updatedAt ?? timestamp),
            self,
          );
        }
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
    const stateNames = new Map<string, number>();
    for (const key of stateIds.keys()) {
      const name = key.slice(key.indexOf("/") + 1);
      stateNames.set(name, (stateNames.get(name) ?? 0) + 1);
    }
    for (const [key, id] of stateIds) {
      byName.states.set(key, id);
      const name = key.slice(key.indexOf("/") + 1);
      if (stateNames.get(name) === 1) byName.states.set(name, id);
    }
    const milestoneNames = new Map<string, number>();
    for (const key of milestoneIds.keys()) {
      const name = key.slice(key.indexOf("/") + 1);
      milestoneNames.set(name, (milestoneNames.get(name) ?? 0) + 1);
    }
    for (const [key, id] of milestoneIds) {
      byName.milestones.set(key, id);
      const name = key.slice(key.indexOf("/") + 1);
      if (milestoneNames.get(name) === 1) byName.milestones.set(name, id);
    }

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
    type RebuildEvent = {
      actor: unknown;
      type: string;
      payload?: Record<string, unknown>;
      ts: string;
    };
    const processHistory = (
      identifier: string,
      issueId: string,
      events: RebuildEvent[],
      useNaturalReferences: boolean,
    ): void => {
      const activityIds: string[] = [];
      for (const event of events) {
        const actorReference = typeof event.actor === "string" ? event.actor : null;
        const actorId =
          (actorReference
            ? (actorIdsBySourceId.get(actorReference) ?? actorIds.get(actorReference))
            : undefined) ?? [...actorIds.values()][0]!;
        // Los comentarios se reconstruyen desde el log: el evento `commented` ya
        // trae autor, fecha y body (AT-165), así que no se duplican en el snapshot.
        if (event.type === "commented" && event.payload?.body) {
          db.query(
            "INSERT INTO comments (id, issue_id, actor_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
          ).run(newId(), issueId, actorId, event.payload.body as string, event.ts);
          result.comments += 1;
        }
        if (event.type === "subscribed") {
          db.query(
            `INSERT INTO issue_subscribers (issue_id, actor_id, created_at)
             VALUES (?1, ?2, ?3) ON CONFLICT(issue_id, actor_id) DO NOTHING`,
          ).run(issueId, actorId, event.ts);
        } else if (event.type === "unsubscribed") {
          db.query("DELETE FROM issue_subscribers WHERE issue_id = ?1 AND actor_id = ?2").run(
            issueId,
            actorId,
          );
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
          JSON.stringify(
            useNaturalReferences
              ? denormalize(event.type, event.payload ?? {})
              : (event.payload ?? {}),
          ),
          event.ts,
        );
        result.events += 1;
      }
      activityIdsByIssue.set(identifier, activityIds);
    };

    // 9. Historial desde los logs por Issue. El stream canónico se usa solo
    // como fallback para un Issue que no tiene log histórico propio.
    const logDir = join(base, "log");
    const logFiles = readdirSync(logDir).filter((file) => file.endsWith(".jsonl"));
    const issueLogFiles = new Set(logFiles.filter((file) => file !== "events.jsonl"));
    for (const file of logFiles) {
      if (file === "events.jsonl") continue;
      const identifier = file.replace(/\.jsonl$/, "");
      const issueId = issueIds.get(identifier);
      if (!issueId) continue;
      const contents = readFileSync(join(logDir, file), "utf8").trim();
      if (!contents) continue;
      const events = contents.split("\n").map((line) => JSON.parse(line) as RebuildEvent);
      processHistory(identifier, issueId, events, true);
    }

    const canonicalEvents = readEventLog({ rootDir });
    const canonicalByIssue = new Map<string, RebuildEvent[]>();
    for (const event of canonicalEvents) {
      if (event.aggregate !== "issue" || !issueIds.has(event.aggregateKey)) continue;
      if (issueLogFiles.has(`${event.aggregateKey}.jsonl`)) continue;
      const events = canonicalByIssue.get(event.aggregateKey) ?? [];
      events.push({
        actor: event.actor,
        type: event.type,
        payload: event.payload as Record<string, unknown>,
        ts: event.occurredAt,
      });
      canonicalByIssue.set(event.aggregateKey, events);
    }
    for (const [identifier, events] of canonicalByIssue) {
      const issueId = issueIds.get(identifier);
      if (issueId) processHistory(identifier, issueId, events, false);
    }
    // Una captura editada manualmente puede declarar duplicateOf sin haber generado los
    // eventos de la mutación. Completa relation_added en ambos extremos solo si
    // el historial no los trae.
    const relationActivityId = (
      issueId: string,
      actorId: string,
      type: "duplicate_of" | "duplicated_by",
      relatedIdentifier: string,
      relatedSourceId: string,
      createdAt: string,
    ): string | null => {
      const activities = db
        .query("SELECT payload FROM activity WHERE issue_id = ?1 AND type = 'relation_added'")
        .all(issueId) as Array<{ payload: string }>;
      const alreadyRecorded = activities.some((activity) => {
        try {
          const payload = JSON.parse(activity.payload) as Record<string, unknown>;
          return (
            payload.type === type &&
            (payload.issue === relatedIdentifier || payload.issue === relatedSourceId)
          );
        } catch {
          return false;
        }
      });
      if (alreadyRecorded) return null;
      const activityId = newId();
      db.query(
        "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, 'relation_added', ?4, ?5)",
      ).run(
        activityId,
        issueId,
        actorId,
        JSON.stringify({ type, issue: relatedIdentifier }),
        createdAt,
      );
      result.events += 1;
      return activityId;
    };
    for (const relation of duplicateRelationEvents) {
      const sourceActivityId = relationActivityId(
        relation.sourceIssueId,
        relation.actorId,
        "duplicate_of",
        relation.targetIdentifier,
        relation.targetIssueId,
        relation.createdAt,
      );
      if (sourceActivityId) {
        const activityIds = activityIdsByIssue.get(relation.sourceIdentifier) ?? [];
        activityIds.push(sourceActivityId);
        activityIdsByIssue.set(relation.sourceIdentifier, activityIds);
      }
      const targetActivityId = relationActivityId(
        relation.targetIssueId,
        relation.actorId,
        "duplicated_by",
        relation.sourceIdentifier,
        relation.sourceIssueId,
        relation.createdAt,
      );
      if (targetActivityId) {
        const activityIds = activityIdsByIssue.get(relation.targetIdentifier) ?? [];
        activityIds.push(targetActivityId);
        activityIdsByIssue.set(relation.targetIdentifier, activityIds);
      }
    }
    // Una captura editada manualmente puede declarar duplicateOf sin haber generado un
    // evento state_changed en el log. Registra la transición solo si el historial no la trae.
    for (const transition of duplicateTransitions) {
      const activities = db
        .query("SELECT payload FROM activity WHERE issue_id = ?1 AND type = 'state_changed'")
        .all(transition.issueId) as Array<{ payload: string }>;
      const alreadyRecorded = activities.some((activity) => {
        try {
          const payload = JSON.parse(activity.payload) as Record<string, unknown>;
          return payload.from === transition.fromStateId && payload.to === transition.toStateId;
        } catch {
          return false;
        }
      });
      if (alreadyRecorded) continue;
      const activityId = newId();
      db.query(
        "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, 'state_changed', ?4, ?5)",
      ).run(
        activityId,
        transition.issueId,
        transition.actorId,
        JSON.stringify({ from: transition.fromStateId, to: transition.toStateId }),
        transition.createdAt,
      );
      result.events += 1;
      const activityIds = activityIdsByIssue.get(transition.identifier) ?? [];
      activityIds.push(activityId);
      activityIdsByIssue.set(transition.identifier, activityIds);
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

    // 10. Restaurar credenciales locales por identidad estable, con fallback legado.
    const rebuiltKeyIds = new Map<string, string>();
    for (const { key } of keyTargets) rebuiltKeyIds.set(String(key.id), String(key.id));
    for (const { key, actor } of keyTargets) {
      const actorId =
        (actor.id != null ? actorIdsBySourceId.get(String(actor.id)) : undefined) ??
        actorIds.get(actor.name as string);
      if (!actorId) {
        throw new Error(`Cannot restore API key ${key.name ?? "<unnamed>"}: actor disappeared`);
      }
      const keyId = rebuiltKeyIds.get(String(key.id));
      if (!keyId)
        throw new Error(`Cannot restore API key ${key.name ?? "<unnamed>"}: missing identity`);
      const rotatedFrom = key.rotated_from_id
        ? (rebuiltKeyIds.get(String(key.rotated_from_id)) ?? null)
        : null;
      db.query(
        "INSERT INTO api_keys (id, actor_id, name, hash, last_used_at, revoked_at, created_at, expires_at, rotated_from_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      ).run(
        keyId,
        actorId,
        key.name as string,
        key.hash as string,
        (key.last_used_at ?? null) as string | null,
        (key.revoked_at ?? null) as string | null,
        key.created_at as string,
        (key.expires_at ?? null) as string | null,
        rotatedFrom,
      );
      for (const scope of keyScopes.get(String(key.id)) ?? []) {
        db.query("INSERT INTO api_key_scopes (api_key_id, scope) VALUES (?1, ?2)").run(
          keyId,
          scope,
        );
      }
      for (const teamKey of keyTeamKeys.get(String(key.id)) ?? []) {
        const teamId = teamIds.get(teamKey);
        if (!teamId)
          throw new Error(
            `Cannot restore API key ${key.name ?? "<unnamed>"}: team limit ${teamKey} is outside this export`,
          );
        db.query("INSERT INTO api_key_team_limits (api_key_id, team_id) VALUES (?1, ?2)").run(
          keyId,
          teamId,
        );
      }
      result.preservedKeys += 1;
    }
    for (const hook of webhooks) {
      const ownerId =
        (hook.owner_id != null ? actorIdsBySourceId.get(String(hook.owner_id)) : undefined) ??
        (hook.owner_name != null ? actorIds.get(String(hook.owner_name)) : undefined) ??
        actorIds.get("admin");
      if (!ownerId) throw new Error("Cannot restore webhook without an owner");
      db.query(
        "INSERT INTO webhooks (id, url, secret, events, enabled, created_at, owner_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).run(
        hook.id as string,
        hook.url as string,
        hook.secret as string,
        hook.events as string,
        hook.enabled as number,
        hook.created_at as string,
        ownerId,
      );
    }
  })();

  return result;
}
