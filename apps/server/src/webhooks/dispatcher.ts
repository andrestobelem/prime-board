// Despachador de webhooks (spec §6): POST JSON firmado con HMAC-SHA256,
// entrega asíncrona con reintentos y backoff.
import type { Database } from "bun:sqlite";
import { now } from "../db/util.ts";
import type { Persistence } from "../db/persistence.ts";
import type { WebhookEventName } from "./events.ts";
import { canAccessTeam, isWorkspaceAdmin } from "../auth/permissions.ts";
import { canAccessPostgresTeam } from "../domain/postgres-teams.ts";
import type { ActorRow } from "../auth/viewer.ts";

export type { WebhookEventName } from "./events.ts";

export interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string | readonly string[];
  enabled: number | boolean;
  created_at: string;
  owner_id: string | null;
  team_id: string | null;
  workspace_id?: string | null;
}

export interface EventActor {
  id: string;
  name: string;
  type: string;
}

export interface DispatcherOptions {
  /** Esperas entre reintentos (ms). El primer intento es inmediato. */
  retryDelays?: number[];
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}

export interface WebhookEventSink {
  emit(
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): void;
  /** Emits an event for a specific Workspace, including its internal scope. */
  emitForWorkspace(
    workspaceId: string,
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): void;
  idle(): Promise<void>;
}

export function signPayload(secret: string, body: string): string {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(body);
  return hasher.digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function redactSecrets(value: string): string {
  return value
    .replace(
      /(\b(?:prime[_ -]?board[_ -]?api[_ -]?key|api[_ -]?key|access[_ -]?token|secret|password)\b\s*[:=]\s*)[^\s,;)}]+/gi,
      "$1[redacted]",
    )
    .replace(/(\bbearer\s+)[^\s,;)}]+/gi, "$1[redacted]")
    .replace(/\bpb_[A-Za-z0-9_-]+\b/g, "[redacted-api-key]");
}

export function safeWebhookUrl(value: string): string {
  try {
    // Conserva solo el origen. Query strings, fragmentos, userinfo y rutas
    // pueden contener credenciales, por lo que ningún componente es seguro en logs.
    return new URL(value).origin;
  } catch {
    return "[redacted-webhook-url]";
  }
}

function parseEvents(events: string | readonly string[]): string[] {
  if (typeof events !== "string") return [...events];
  try {
    const parsed: unknown = JSON.parse(events);
    return Array.isArray(parsed) && parsed.every((event) => typeof event === "string")
      ? parsed
      : ["*"];
  } catch {
    return ["*"];
  }
}

function sqliteSingleWorkspaceId(db: Database): string | null {
  const rows = db.query("SELECT id FROM workspace ORDER BY created_at, id").all() as Array<{
    id: string;
  }>;
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Deriva el alcance del evento antes de leer hooks o permisos. */
function sqliteEventWorkspaceId(
  db: Database,
  event: WebhookEventName,
  data: Record<string, unknown>,
): string | null {
  if (typeof data._workspaceId === "string") {
    const workspace = db.query("SELECT id FROM workspace WHERE id = ?1").get(data._workspaceId) as {
      id: string;
    } | null;
    return workspace?.id ?? null;
  }

  const teamId =
    typeof data.teamId === "string"
      ? data.teamId
      : event.startsWith("team.") && typeof data.id === "string"
        ? data.id
        : null;
  if (teamId) {
    const row = db.query("SELECT workspace_id FROM teams WHERE id = ?1").get(teamId) as {
      workspace_id: string | null;
    } | null;
    if (row?.workspace_id) return row.workspace_id;
  }

  const issueId =
    typeof data.issueId === "string"
      ? data.issueId
      : event.startsWith("issue.") && typeof data.id === "string"
        ? data.id
        : null;
  if (issueId) {
    const row = db.query("SELECT workspace_id FROM issues WHERE id = ?1").get(issueId) as {
      workspace_id: string | null;
    } | null;
    if (row?.workspace_id) return row.workspace_id;
  }

  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : event.startsWith("project.") && typeof data.id === "string"
        ? data.id
        : null;
  if (projectId) {
    const project = db.query("SELECT workspace_id FROM projects WHERE id = ?1").get(projectId) as {
      workspace_id: string | null;
    } | null;
    if (project?.workspace_id) return project.workspace_id;
    const team = db
      .query("SELECT workspace_id FROM project_teams WHERE project_id = ?1 LIMIT 1")
      .get(projectId) as { workspace_id: string | null } | null;
    if (team?.workspace_id) return team.workspace_id;
  }

  // `team.deleted` no longer has a root row. This fallback preserves legacy
  // single-Workspace delivery and fails closed when the topology is ambiguous.
  return sqliteSingleWorkspaceId(db);
}

/**
 * Valida que el Workspace explícito coincida con cada recurso del evento.
 * Aunque el sink scopeado es un límite interno, un ID de recurso incorrecto
 * debe fallar cerrado y no convertir una búsqueda vacía de Team en un
 * broadcast a los Webhooks del Workspace.
 */
function sqliteEventMatchesWorkspace(
  db: Database,
  event: WebhookEventName,
  data: Record<string, unknown>,
  workspaceId: string,
): boolean {
  const workspace = db.query("SELECT id FROM workspace WHERE id = ?1").get(workspaceId);
  if (!workspace) return false;

  const teamId =
    typeof data.teamId === "string"
      ? data.teamId
      : event.startsWith("team.") && typeof data.id === "string"
        ? data.id
        : null;
  if (teamId) {
    const team = db.query("SELECT workspace_id FROM teams WHERE id = ?1").get(teamId) as {
      workspace_id: string | null;
    } | null;
    if (!team) {
      // La fila del Team se elimina antes de despachar team.deleted. El
      // resolver conserva su Workspace antes de borrarlo; un snapshot de
      // owners no prueba por sí solo el origen del evento.
      const deletedTeamWorkspaceId =
        typeof data._teamWorkspaceId === "string" ? data._teamWorkspaceId : null;
      if (
        (event !== "team.created" && event !== "team.deleted") ||
        deletedTeamWorkspaceId !== workspaceId
      )
        return false;
    } else if (team.workspace_id !== workspaceId) {
      return false;
    }
  }

  const issueId =
    typeof data.issueId === "string"
      ? data.issueId
      : event.startsWith("issue.") && typeof data.id === "string"
        ? data.id
        : null;
  if (issueId) {
    const issue = db
      .query("SELECT workspace_id, team_id FROM issues WHERE id = ?1")
      .get(issueId) as {
      workspace_id: string | null;
      team_id: string;
    } | null;
    if (!issue || issue.workspace_id !== workspaceId) return false;
    if (teamId && issue.team_id !== teamId) return false;
  }

  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : event.startsWith("project.") && typeof data.id === "string"
        ? data.id
        : null;
  if (projectId) {
    const project = db.query("SELECT workspace_id FROM projects WHERE id = ?1").get(projectId) as {
      workspace_id: string | null;
    } | null;
    if (!project || project.workspace_id !== workspaceId) return false;
    if (teamId) {
      const relation = db
        .query("SELECT workspace_id FROM project_teams WHERE project_id = ?1 AND team_id = ?2")
        .get(projectId, teamId) as { workspace_id: string | null } | null;
      if (!relation || relation.workspace_id !== workspaceId) return false;
    }
  }

  if (event.startsWith("workspace.") && typeof data.id === "string" && data.id !== workspaceId) {
    return false;
  }
  return true;
}

function sqliteEventTeamIds(
  db: Database,
  event: WebhookEventName,
  data: Record<string, unknown>,
  workspaceId: string,
): string[] {
  const scope =
    "(workspace_id = ?2 OR (workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1))";
  const direct =
    typeof data.teamId === "string"
      ? [data.teamId]
      : event.startsWith("team.") && typeof data.id === "string"
        ? [data.id]
        : [];
  if (direct.length > 0) {
    const [teamId] = direct;
    if (!teamId) return [];
    const team = db
      .query(`SELECT id FROM teams WHERE id = ?1 AND ${scope}`)
      .get(teamId, workspaceId);
    if (team) return direct;
    const markerWorkspaceId =
      typeof data._teamWorkspaceId === "string" ? data._teamWorkspaceId : null;
    return (event === "team.created" || event === "team.deleted") &&
      markerWorkspaceId === workspaceId
      ? direct
      : [];
  }
  const issueId =
    typeof data.issueId === "string"
      ? data.issueId
      : event.startsWith("issue.") && typeof data.id === "string"
        ? data.id
        : null;
  if (issueId) {
    const row = db
      .query(`SELECT team_id FROM issues WHERE id = ?1 AND ${scope}`)
      .get(issueId, workspaceId) as { team_id: string } | null;
    return row ? [row.team_id] : [];
  }
  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : event.startsWith("project.") && typeof data.id === "string"
        ? data.id
        : null;
  if (projectId) {
    return (
      db
        .query(`SELECT team_id FROM project_teams WHERE project_id = ?1 AND ${scope}`)
        .all(projectId, workspaceId) as Array<{ team_id: string }>
    ).map((row) => row.team_id);
  }
  return [];
}

async function postgresSingleWorkspaceId(persistence: Persistence): Promise<string | null> {
  const rows = await persistence.many<{ id: string }>(
    "SELECT id FROM workspace ORDER BY created_at, id",
  );
  return rows.length === 1 ? rows[0]!.id : null;
}

/** El esquema PostgreSQL actual es singleton. Rechaza un scope explícito ajeno. */
async function postgresEventWorkspaceId(
  persistence: Persistence,
  data: Record<string, unknown>,
): Promise<string | null> {
  const workspaceId = await postgresSingleWorkspaceId(persistence);
  if (!workspaceId) return null;
  if (data._workspaceId !== undefined) {
    return typeof data._workspaceId === "string" && data._workspaceId === workspaceId
      ? workspaceId
      : null;
  }
  return workspaceId;
}

/** Valida recursos del evento contra el único Workspace PostgreSQL soportado hoy. */
async function postgresEventMatchesWorkspace(
  persistence: Persistence,
  event: WebhookEventName,
  data: Record<string, unknown>,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await persistence.one<{ id: string }>(
    "SELECT id FROM workspace WHERE id = $1",
    [workspaceId],
  );
  if (!workspace) return false;

  const teamId =
    typeof data.teamId === "string"
      ? data.teamId
      : event.startsWith("team.") && typeof data.id === "string"
        ? data.id
        : null;
  if (teamId) {
    const team = await persistence.one<{ id: string }>("SELECT id FROM teams WHERE id = $1", [
      teamId,
    ]);
    if (!team) {
      const deletedTeamWorkspaceId =
        typeof data._teamWorkspaceId === "string" ? data._teamWorkspaceId : null;
      if (
        (event !== "team.created" && event !== "team.deleted") ||
        deletedTeamWorkspaceId !== workspaceId
      )
        return false;
    }
  }

  const issueId =
    typeof data.issueId === "string"
      ? data.issueId
      : event.startsWith("issue.") && typeof data.id === "string"
        ? data.id
        : null;
  if (issueId) {
    const issue = await persistence.one<{ id: string; team_id: string }>(
      "SELECT id, team_id FROM issues WHERE id = $1",
      [issueId],
    );
    if (!issue || (teamId && issue.team_id !== teamId)) return false;
  }

  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : event.startsWith("project.") && typeof data.id === "string"
        ? data.id
        : null;
  if (projectId) {
    const project = await persistence.one<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
      projectId,
    ]);
    if (!project) return false;
    if (teamId) {
      const relation = await persistence.one<{ project_id: string }>(
        "SELECT project_id FROM project_teams WHERE project_id = $1 AND team_id = $2",
        [projectId, teamId],
      );
      if (!relation) return false;
    }
  }

  if (event.startsWith("workspace.") && typeof data.id === "string" && data.id !== workspaceId)
    return false;
  return true;
}

async function postgresEventTeamIds(
  persistence: Persistence,
  event: WebhookEventName,
  data: Record<string, unknown>,
): Promise<string[]> {
  const direct =
    typeof data.teamId === "string"
      ? [data.teamId]
      : event.startsWith("team.") && typeof data.id === "string"
        ? [data.id]
        : [];
  if (direct.length > 0) return direct;
  const issueId =
    typeof data.issueId === "string"
      ? data.issueId
      : event.startsWith("issue.") && typeof data.id === "string"
        ? data.id
        : null;
  if (issueId) {
    const row = await persistence.one<{ team_id: string }>(
      "SELECT team_id FROM issues WHERE id = $1",
      [issueId],
    );
    return row ? [row.team_id] : [];
  }
  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : event.startsWith("project.") && typeof data.id === "string"
        ? data.id
        : null;
  if (projectId) {
    const rows = await persistence.many<{ team_id: string }>(
      "SELECT team_id FROM project_teams WHERE project_id = $1",
      [projectId],
    );
    return rows.map((row) => row.team_id);
  }
  return [];
}

async function sqliteOwnerCanReceive(
  db: Database,
  ownerId: string | null,
  teamIds: readonly string[],
  workspaceId: string,
  deletedTeamOwnerIds: readonly string[] = [],
): Promise<boolean> {
  if (!ownerId) return false;
  const owner = db
    .query(
      `SELECT actors.*, memberships.role AS workspace_role
         FROM actors
         JOIN workspace_memberships AS memberships
           ON memberships.actor_id = actors.id
          AND memberships.workspace_id = ?2
          AND memberships.status = 'active'
        WHERE actors.id = ?1`,
    )
    .get(ownerId, workspaceId) as ActorRow | null;
  if (!owner || owner.status !== "active") return false;

  const scope =
    "(workspace_id = ?2 OR (workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1))";
  return teamIds.every((teamId) => {
    const team = db
      .query(`SELECT id FROM teams WHERE id = ?1 AND ${scope}`)
      .get(teamId, workspaceId);
    return Boolean(
      team
        ? canAccessTeam(db, owner, teamId)
        : isWorkspaceAdmin(owner) || deletedTeamOwnerIds.includes(ownerId),
    );
  });
}

async function postgresOwnerCanReceive(
  persistence: Persistence,
  ownerId: string | null,
  teamIds: readonly string[],
  workspaceId: string,
  deletedTeamOwnerIds: readonly string[] = [],
): Promise<boolean> {
  if (!ownerId) return false;
  // Actor status is global compatibility state. Delivery authority is the
  // active Membership in the effective Workspace.
  const owner = await persistence.one<{ id: string; status: string; workspace_role: string }>(
    `SELECT actors.id, actors.status, memberships.role AS workspace_role
       FROM actors
       JOIN workspace_memberships AS memberships
         ON memberships.actor_id = actors.id
        AND memberships.workspace_id = $2
        AND memberships.status = 'active'
      WHERE actors.id = $1`,
    [ownerId, workspaceId],
  );
  if (!owner || owner.status !== "active") return false;
  for (const teamId of teamIds) {
    const team = await persistence.one<{ id: string }>("SELECT id FROM teams WHERE id = $1", [
      teamId,
    ]);
    const allowed = team
      ? await canAccessPostgresTeam(persistence, owner, teamId)
      : owner.workspace_role === "admin" || deletedTeamOwnerIds.includes(ownerId);
    if (!allowed) return false;
  }
  return true;
}

async function allAsync(values: readonly Promise<boolean>[]): Promise<boolean> {
  const resolved = await Promise.all(values);
  return resolved.every(Boolean);
}

export class WebhookDispatcher implements WebhookEventSink {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly options: DispatcherOptions = {},
    private readonly persistence?: Persistence,
  ) {}

  /** Emite un evento a todos los webhooks suscriptos. No bloquea al caller. */
  emit(
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): void {
    this.enqueue(event, actor, data, changes);
  }

  /** Adds the effective Workspace to an event before dispatch. */
  emitForWorkspace(
    workspaceId: string,
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): void {
    this.enqueue(event, actor, { ...data, _workspaceId: workspaceId }, changes);
  }

  /** Creates the request-scoped event sink used by GraphQL resolvers. */
  scoped(workspaceId: string): WebhookEventSink {
    return {
      emit: (event, actor, data, changes) =>
        this.emitForWorkspace(workspaceId, event, actor, data, changes),
      emitForWorkspace: (targetWorkspaceId, event, actor, data, changes) =>
        this.emitForWorkspace(targetWorkspaceId, event, actor, data, changes),
      idle: () => this.idle(),
    };
  }

  private enqueue(
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): void {
    const dispatch = this.dispatch(event, actor, data, changes).catch((error) => {
      this.options.log?.(`webhook dispatch failed: ${redactSecrets(String(error))}`);
    });
    this.pending.add(dispatch);
    void dispatch.finally(() => this.pending.delete(dispatch)).catch(() => undefined);
  }

  /** Espera a que terminen todas las entregas en vuelo (para tests y shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async dispatch(
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): Promise<void> {
    const workspaceId = this.persistence
      ? await postgresEventWorkspaceId(this.persistence, data)
      : sqliteEventWorkspaceId(this.db, event, data);
    if (!workspaceId) return;
    const matchesWorkspace = this.persistence
      ? await postgresEventMatchesWorkspace(this.persistence, event, data, workspaceId)
      : sqliteEventMatchesWorkspace(this.db, event, data, workspaceId);
    if (!matchesWorkspace) return;

    const hooks = this.persistence
      ? (
          await this.persistence.many<WebhookRow>("SELECT * FROM webhooks WHERE enabled = TRUE")
        ).filter((hook) => hook.workspace_id == null || hook.workspace_id === workspaceId)
      : (this.db
          .query(
            `SELECT * FROM webhooks
             WHERE enabled = 1
               AND (workspace_id = ?1 OR
                    (workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1))`,
          )
          .all(workspaceId) as WebhookRow[]);
    const teamIds = this.persistence
      ? await postgresEventTeamIds(this.persistence, event, data)
      : sqliteEventTeamIds(this.db, event, data, workspaceId);
    const deletedTeamOwnerIds =
      event === "team.deleted" && Array.isArray(data._teamOwnerIds)
        ? data._teamOwnerIds.filter((id): id is string => typeof id === "string")
        : [];
    const canReceive = async (hook: WebhookRow): Promise<boolean> => {
      const ownerCanReceive = this.persistence
        ? await postgresOwnerCanReceive(
            this.persistence,
            hook.owner_id,
            teamIds,
            workspaceId,
            deletedTeamOwnerIds,
          )
        : await sqliteOwnerCanReceive(
            this.db,
            hook.owner_id,
            teamIds,
            workspaceId,
            deletedTeamOwnerIds,
          );
      if (!ownerCanReceive) return false;
      if (!hook.team_id) return true;
      if (!teamIds.includes(hook.team_id)) return false;
      return this.persistence
        ? postgresOwnerCanReceive(
            this.persistence,
            hook.owner_id,
            [hook.team_id],
            workspaceId,
            deletedTeamOwnerIds,
          )
        : sqliteOwnerCanReceive(
            this.db,
            hook.owner_id,
            [hook.team_id],
            workspaceId,
            deletedTeamOwnerIds,
          );
    };
    const subscribed: WebhookRow[] = [];
    for (const hook of hooks) {
      const events = parseEvents(hook.events);
      if (!(events.includes("*") || events.includes(event))) continue;
      if (await canReceive(hook)) subscribed.push(hook);
    }
    if (subscribed.length === 0) return;

    const publicData = Object.fromEntries(
      Object.entries(data).filter(
        ([key]) => key !== "_teamOwnerIds" && key !== "_teamWorkspaceId" && key !== "_workspaceId",
      ),
    );
    const body = JSON.stringify({
      event,
      workspaceId,
      actor: { id: actor.id, name: actor.name, type: actor.type },
      data: publicData,
      ...(changes && Object.keys(changes).length > 0 ? { changes } : {}),
      createdAt: now(),
    });

    await allAsync(
      subscribed.map((hook) =>
        this.deliver(hook, body, () => canReceive(hook)).catch((error) => {
          this.options.log?.(
            `webhook delivery to ${safeWebhookUrl(hook.url)} failed: ${redactSecrets(String(error))}`,
          );
          return false;
        }),
      ),
    );
  }

  private async deliver(
    hook: WebhookRow,
    body: string,
    canReceive?: () => Promise<boolean>,
  ): Promise<boolean> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const delays = this.options.retryDelays ?? [1_000, 5_000, 25_000];
    const signature = signPayload(hook.secret, body);

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      // Recheck membership before every attempt. A suspended or departed
      // owner must stop an in-flight retry without deleting historical data.
      if (canReceive && !(await canReceive())) return false;
      try {
        const response = await fetchFn(hook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-primeboard-signature": signature,
          },
          body,
        });
        if (response.ok) return true;
        throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (attempt === delays.length) throw error;
        await sleep(delays[attempt]!);
      }
    }
    return false;
  }
}
