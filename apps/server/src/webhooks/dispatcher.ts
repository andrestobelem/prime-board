// Despachador de webhooks (spec §6): POST JSON firmado con HMAC-SHA256,
// entrega asíncrona con reintentos y backoff. Cola en memoria (MVP).
import type { Database } from "bun:sqlite";
import { now } from "../db/util.ts";
import type { WebhookEventName } from "./events.ts";
import { canAccessTeam, isWorkspaceAdmin } from "../auth/permissions.ts";
import type { ActorRow } from "../auth/viewer.ts";

export type { WebhookEventName } from "./events.ts";

export interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  enabled: number;
  created_at: string;
  owner_id: string | null;
  team_id: string | null;
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

function eventTeamIds(
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

function ownerCanReceive(
  db: Database,
  ownerId: string | null,
  teamIds: readonly string[],
  deletedTeamOwnerIds: readonly string[] = [],
): boolean {
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

export class WebhookDispatcher {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly options: DispatcherOptions = {},
  ) {}

  /** Emite un evento a todos los webhooks suscriptos. No bloquea al caller. */
  emit(
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): void {
    const hooks = this.db.query("SELECT * FROM webhooks WHERE enabled = 1").all() as WebhookRow[];
    const teamIds = eventTeamIds(this.db, event, data);
    const deletedTeamOwnerIds =
      event === "team.deleted" && Array.isArray(data._teamOwnerIds)
        ? data._teamOwnerIds.filter((id): id is string => typeof id === "string")
        : [];
    const subscribed = hooks.filter((hook) => {
      const events = JSON.parse(hook.events) as string[];
      if (!(events.includes("*") || events.includes(event))) return false;
      if (
        hook.team_id &&
        (!teamIds.includes(hook.team_id) ||
          !ownerCanReceive(this.db, hook.owner_id, [hook.team_id], deletedTeamOwnerIds))
      ) {
        return false;
      }
      // Legacy/global hooks are still owner-scoped: an owner must be able to
      // read every Team touched by the event before receiving its payload.
      return ownerCanReceive(this.db, hook.owner_id, teamIds, deletedTeamOwnerIds);
    });
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

    for (const hook of subscribed) {
      const delivery = this.deliver(hook, body).catch((error) => {
        this.options.log?.(`webhook delivery to ${hook.url} failed: ${error}`);
      });
      this.pending.add(delivery);
      delivery.finally(() => this.pending.delete(delivery));
    }
  }

  /** Espera a que terminen todas las entregas en vuelo (para tests y shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async deliver(hook: WebhookRow, body: string): Promise<void> {
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
        if (response.ok) return;
        throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (attempt === delays.length) throw error;
        await sleep(delays[attempt]!);
      }
    }
  }
}
