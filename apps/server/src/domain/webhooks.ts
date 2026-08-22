// Dominio de webhooks: registro y baja (spec §6).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import type { WebhookRow } from "../webhooks/dispatcher.ts";
import { isWebhookEventName } from "../webhooks/events.ts";
import { canAccessTeam } from "../auth/permissions.ts";
import type { ActorRow } from "../auth/viewer.ts";

type ViewerRef = string | ActorRow;

function resolveViewer(db: Database, viewer: ViewerRef): ActorRow | null {
  if (typeof viewer !== "string") return viewer;
  return db.query("SELECT * FROM actors WHERE id = ?1").get(viewer) as ActorRow | null;
}

function viewerId(viewer: ViewerRef): string {
  return typeof viewer === "string" ? viewer : viewer.id;
}

export function mapWebhook(row: WebhookRow) {
  return {
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    enabled: row.enabled === 1,
    teamId: row.team_id,
    createdAt: row.created_at,
  };
}

export function listWebhooks(
  db: Database,
  viewer: ViewerRef,
  isAdmin: boolean,
  workspaceId?: string,
): WebhookRow[] {
  const actorId = viewerId(viewer);
  const query = workspaceId
    ? isAdmin
      ? "SELECT * FROM webhooks WHERE workspace_id = ?1 ORDER BY created_at"
      : "SELECT * FROM webhooks WHERE owner_id = ?1 AND workspace_id = ?2 ORDER BY created_at"
    : isAdmin
      ? "SELECT * FROM webhooks ORDER BY created_at"
      : "SELECT * FROM webhooks WHERE owner_id = ?1 ORDER BY created_at";
  const rows = (
    workspaceId
      ? isAdmin
        ? db.query(query).all(workspaceId)
        : db.query(query).all(actorId, workspaceId)
      : db.query(query).all(actorId)
  ) as WebhookRow[];
  if (isAdmin) return rows;
  const actor = resolveViewer(db, viewer);
  return rows.filter(
    (row) => !row.team_id || Boolean(actor && canAccessTeam(db, actor, row.team_id)),
  );
}

export function createWebhook(
  db: Database,
  ownerRef: ViewerRef,
  input: { url: string; secret?: string | null; events?: string[] | null; teamId?: string | null },
  workspaceId?: string,
): { row: WebhookRow; secret: string } {
  const ownerId = viewerId(ownerRef);
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw apiError("VALIDATION_FAILED", "Webhook url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw apiError("VALIDATION_FAILED", "Webhook url must be http or https");
  }

  const events = input.events?.length ? [...new Set(input.events)] : ["*"];
  const invalidEvent = events.find((event) => event !== "*" && !isWebhookEventName(event));
  if (invalidEvent) {
    throw apiError("VALIDATION_FAILED", `Unknown webhook event: ${invalidEvent}`);
  }

  // Si no se provee secret, se genera uno y se devuelve una única vez.
  const secret =
    input.secret?.trim() ||
    Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

  const id = newId();
  db.query(
    "INSERT INTO webhooks (id, url, secret, events, enabled, created_at, owner_id, team_id, workspace_id) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8)",
  ).run(
    id,
    input.url,
    secret,
    JSON.stringify(events),
    now(),
    ownerId,
    input.teamId ?? null,
    workspaceId ?? null,
  );
  const row = (
    workspaceId
      ? db.query("SELECT * FROM webhooks WHERE id = ?1 AND workspace_id = ?2").get(id, workspaceId)
      : db.query("SELECT * FROM webhooks WHERE id = ?1").get(id)
  ) as WebhookRow;
  return { row, secret };
}

export function deleteWebhook(
  db: Database,
  id: string,
  viewer: ViewerRef,
  isAdmin: boolean,
  workspaceId?: string,
): boolean {
  const actorId = viewerId(viewer);
  const query = workspaceId
    ? "SELECT id, owner_id FROM webhooks WHERE id = ?1 AND workspace_id = ?2"
    : "SELECT id, owner_id FROM webhooks WHERE id = ?1";
  const existing = (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as {
    id: string;
    owner_id: string | null;
  } | null;
  if (!existing) throw apiError("NOT_FOUND", "Webhook not found");
  if (!isAdmin && existing.owner_id !== actorId) {
    throw apiError("UNAUTHORIZED", "You can only manage your own webhooks");
  }
  if (workspaceId) {
    db.query("DELETE FROM webhooks WHERE id = ?1 AND workspace_id = ?2").run(id, workspaceId);
  } else {
    db.query("DELETE FROM webhooks WHERE id = ?1").run(id);
  }
  return true;
}
