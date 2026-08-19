// Dominio de webhooks: registro y baja (spec §6).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import type { WebhookRow } from "../webhooks/dispatcher.ts";
import { isWebhookEventName } from "../webhooks/events.ts";
import { canAccessTeam } from "../auth/permissions.ts";
import type { ActorRow } from "../auth/viewer.ts";

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

export function listWebhooks(db: Database, actorId: string, isAdmin: boolean): WebhookRow[] {
  const rows = (
    isAdmin
      ? db.query("SELECT * FROM webhooks ORDER BY created_at").all()
      : db.query("SELECT * FROM webhooks WHERE owner_id = ?1 ORDER BY created_at").all(actorId)
  ) as WebhookRow[];
  if (isAdmin) return rows;
  const actor = db.query("SELECT * FROM actors WHERE id = ?1").get(actorId) as ActorRow | null;
  return rows.filter(
    (row) => !row.team_id || Boolean(actor && canAccessTeam(db, actor, row.team_id)),
  );
}

export function createWebhook(
  db: Database,
  ownerId: string,
  input: { url: string; secret?: string | null; events?: string[] | null; teamId?: string | null },
): { row: WebhookRow; secret: string } {
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
    "INSERT INTO webhooks (id, url, secret, events, enabled, created_at, owner_id, team_id) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)",
  ).run(id, input.url, secret, JSON.stringify(events), now(), ownerId, input.teamId ?? null);
  const row = db.query("SELECT * FROM webhooks WHERE id = ?1").get(id) as WebhookRow;
  return { row, secret };
}

export function deleteWebhook(
  db: Database,
  id: string,
  actorId: string,
  isAdmin: boolean,
): boolean {
  const existing = db.query("SELECT id, owner_id FROM webhooks WHERE id = ?1").get(id) as {
    id: string;
    owner_id: string | null;
  } | null;
  if (!existing) throw apiError("NOT_FOUND", "Webhook not found");
  if (!isAdmin && existing.owner_id !== actorId) {
    throw apiError("UNAUTHORIZED", "You can only manage your own webhooks");
  }
  db.query("DELETE FROM webhooks WHERE id = ?1").run(id);
  return true;
}
