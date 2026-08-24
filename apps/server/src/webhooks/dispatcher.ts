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

function sqliteEventTeamIds(
  db: Database,
  event: WebhookEventName,
  data: Record<string, unknown>,
): string[] {
  const direct =
    typeof data.teamId === "string"
      ? [data.teamId]
      : event.startsWith("team.") && typeof data.id === "string"
        ? [data.id]
        : [];
  if (direct.length > 0) return direct;
  const issueId = typeof data.issueId === "string" ? data.issueId : null;
  if (issueId) {
    const row = db.query("SELECT team_id FROM issues WHERE id = ?1").get(issueId) as {
      team_id: string;
    } | null;
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
      db.query("SELECT team_id FROM project_teams WHERE project_id = ?1").all(projectId) as Array<{
        team_id: string;
      }>
    ).map((row) => row.team_id);
  }
  return [];
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
  const issueId = typeof data.issueId === "string" ? data.issueId : null;
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
  deletedTeamOwnerIds: readonly string[] = [],
): Promise<boolean> {
  if (!ownerId) return false;
  const owner = db.query("SELECT * FROM actors WHERE id = ?1").get(ownerId) as ActorRow | null;
  return Boolean(
    owner &&
    owner.status === "active" &&
    teamIds.every((teamId) => {
      const team = db.query("SELECT id FROM teams WHERE id = ?1").get(teamId);
      return Boolean(
        team
          ? canAccessTeam(db, owner, teamId)
          : isWorkspaceAdmin(owner) || deletedTeamOwnerIds.includes(ownerId),
      );
    }),
  );
}

async function postgresOwnerCanReceive(
  persistence: Persistence,
  ownerId: string | null,
  teamIds: readonly string[],
  deletedTeamOwnerIds: readonly string[] = [],
): Promise<boolean> {
  if (!ownerId) return false;
  const owner = await persistence.one<{ id: string; status: string; workspace_role: string }>(
    "SELECT id, status, workspace_role FROM actors WHERE id = $1",
    [ownerId],
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

export class WebhookDispatcher {
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
    const hooks = this.persistence
      ? await this.persistence.many<WebhookRow>("SELECT * FROM webhooks WHERE enabled = TRUE")
      : (this.db.query("SELECT * FROM webhooks WHERE enabled = 1").all() as WebhookRow[]);
    const teamIds = this.persistence
      ? await postgresEventTeamIds(this.persistence, event, data)
      : sqliteEventTeamIds(this.db, event, data);
    const deletedTeamOwnerIds =
      event === "team.deleted" && Array.isArray(data._teamOwnerIds)
        ? data._teamOwnerIds.filter((id): id is string => typeof id === "string")
        : [];
    const subscribed: WebhookRow[] = [];
    for (const hook of hooks) {
      const events = parseEvents(hook.events);
      if (!(events.includes("*") || events.includes(event))) continue;
      const ownerCanReceive = this.persistence
        ? await postgresOwnerCanReceive(
            this.persistence,
            hook.owner_id,
            teamIds,
            deletedTeamOwnerIds,
          )
        : await sqliteOwnerCanReceive(this.db, hook.owner_id, teamIds, deletedTeamOwnerIds);
      if (
        hook.team_id &&
        (!teamIds.includes(hook.team_id) ||
          !(this.persistence
            ? await postgresOwnerCanReceive(
                this.persistence,
                hook.owner_id,
                [hook.team_id],
                deletedTeamOwnerIds,
              )
            : await sqliteOwnerCanReceive(
                this.db,
                hook.owner_id,
                [hook.team_id],
                deletedTeamOwnerIds,
              )))
      ) {
        continue;
      }
      if (ownerCanReceive) subscribed.push(hook);
    }
    if (subscribed.length === 0) return;

    const publicData = Object.fromEntries(
      Object.entries(data).filter(([key]) => key !== "_teamOwnerIds"),
    );
    const body = JSON.stringify({
      event,
      actor: { id: actor.id, name: actor.name, type: actor.type },
      data: publicData,
      ...(changes && Object.keys(changes).length > 0 ? { changes } : {}),
      createdAt: now(),
    });

    await allAsync(
      subscribed.map((hook) =>
        this.deliver(hook, body).catch((error) => {
          this.options.log?.(
            `webhook delivery to ${safeWebhookUrl(hook.url)} failed: ${redactSecrets(String(error))}`,
          );
          return false;
        }),
      ),
    );
  }

  private async deliver(hook: WebhookRow, body: string): Promise<boolean> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const delays = this.options.retryDelays ?? [1_000, 5_000, 25_000];
    const signature = signPayload(hook.secret, body);

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
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
