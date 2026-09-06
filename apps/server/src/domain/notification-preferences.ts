// Preferencias personales de notificaciones (PRB-386).
// Este dominio solo persiste la configuración. Los transportes externos y la
// adaptación de Inbox se implementan en superficies posteriores.
import type { Database } from "bun:sqlite";
import { now } from "../db/util.ts";
import { apiError } from "../graphql/errors.ts";

/**
 * Categorías del vertical actual:
 * - assignments: asignaciones al Actor.
 * - mentions: menciones directas al Actor.
 * - comments: comentarios en Issues relevantes.
 * - status_changes: cambios de estado o prioridad.
 * - reviews: solicitudes y cambios de Reviews.
 * - project_updates: actualizaciones narrativas de Projects.
 */
export const NOTIFICATION_CATEGORIES = [
  "assignments",
  "mentions",
  "comments",
  "status_changes",
  "reviews",
  "project_updates",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Canales de configuración documentados por Linear. Esta unidad persiste la
 * preferencia, pero no implementa transportes Desktop/Mobile/Email/Slack.
 */
export const NOTIFICATION_CHANNELS = ["inbox", "desktop", "mobile", "email", "slack"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Email soporta resumen diferido (digest) o entrega inmediata. */
export const NOTIFICATION_EMAIL_DELIVERIES = ["digest", "immediate"] as const;
export type NotificationEmailDelivery = (typeof NOTIFICATION_EMAIL_DELIVERIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(NOTIFICATION_CATEGORIES);
const CHANNEL_SET: ReadonlySet<string> = new Set(NOTIFICATION_CHANNELS);
const EMAIL_DELIVERY_SET: ReadonlySet<string> = new Set(NOTIFICATION_EMAIL_DELIVERIES);

export interface NotificationPreferenceRow {
  workspace_id: string;
  actor_id: string;
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: number;
  email_delivery: NotificationEmailDelivery | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationPreference {
  workspaceId: string;
  actorId: string;
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
  emailDelivery: NotificationEmailDelivery | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPreferenceInput {
  category?: unknown;
  channel?: unknown;
  enabled?: unknown;
  emailDelivery?: unknown;
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return CATEGORY_SET.has(value);
}

export function isNotificationChannel(value: string): value is NotificationChannel {
  return CHANNEL_SET.has(value);
}

export function isNotificationEmailDelivery(value: string): value is NotificationEmailDelivery {
  return EMAIL_DELIVERY_SET.has(value);
}

function normalizeCategory(value: unknown): NotificationCategory {
  if (typeof value === "string" && isNotificationCategory(value)) return value;
  throw apiError("VALIDATION_FAILED", "Invalid notification category");
}

function normalizeChannel(value: unknown): NotificationChannel {
  if (typeof value === "string" && isNotificationChannel(value)) return value;
  throw apiError("VALIDATION_FAILED", "Invalid notification channel");
}

function normalizeEmailDelivery(value: unknown): NotificationEmailDelivery {
  if (typeof value === "string" && isNotificationEmailDelivery(value)) return value;
  throw apiError("VALIDATION_FAILED", "Invalid email notification delivery");
}

function assertActiveMembership(db: Database, workspaceId: string, actorId: string): void {
  const membership = db
    .query(
      `SELECT 1
       FROM workspace_memberships
       WHERE workspace_id = ?1 AND actor_id = ?2 AND status = 'active'`,
    )
    .get(workspaceId, actorId);
  if (!membership) {
    throw apiError(
      "UNAUTHORIZED",
      "Notification preferences require an active Workspace membership",
    );
  }
}

function preferenceKey(category: NotificationCategory, channel: NotificationChannel): string {
  return `${category}:${channel}`;
}

function getRows(db: Database, workspaceId: string, actorId: string): NotificationPreferenceRow[] {
  return db
    .query(
      `SELECT workspace_id, actor_id, category, channel, enabled, email_delivery,
              created_at, updated_at
       FROM notification_preferences
       WHERE workspace_id = ?1 AND actor_id = ?2`,
    )
    .all(workspaceId, actorId) as NotificationPreferenceRow[];
}

function ensureRows(db: Database, workspaceId: string, actorId: string): void {
  assertActiveMembership(db, workspaceId, actorId);
  const timestamp = now();
  const insert = db.query(
    `INSERT INTO notification_preferences
       (workspace_id, actor_id, category, channel, enabled, email_delivery, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?6)
     ON CONFLICT (workspace_id, actor_id, category, channel) DO NOTHING`,
  );
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      insert.run(
        workspaceId,
        actorId,
        category,
        channel,
        channel === "email" ? "digest" : null,
        timestamp,
      );
    }
  }
}

function orderRows(rows: NotificationPreferenceRow[]): NotificationPreferenceRow[] {
  const categoryOrder = new Map(
    NOTIFICATION_CATEGORIES.map((category, index) => [category, index]),
  );
  const channelOrder = new Map(NOTIFICATION_CHANNELS.map((channel, index) => [channel, index]));
  return [...rows].sort(
    (left, right) =>
      (categoryOrder.get(left.category) ?? Number.MAX_SAFE_INTEGER) -
        (categoryOrder.get(right.category) ?? Number.MAX_SAFE_INTEGER) ||
      (channelOrder.get(left.channel) ?? Number.MAX_SAFE_INTEGER) -
        (channelOrder.get(right.channel) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function getNotificationPreferences(
  db: Database,
  workspaceId: string,
  actorId: string,
): NotificationPreferenceRow[] {
  ensureRows(db, workspaceId, actorId);
  return orderRows(getRows(db, workspaceId, actorId));
}

function normalizeInputs(inputs: readonly NotificationPreferenceInput[]): Array<{
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
  emailDelivery: NotificationEmailDelivery | undefined;
}> {
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw apiError("VALIDATION_FAILED", `Notification preference ${index} must be an object`);
    }
    const category = normalizeCategory(input.category);
    const channel = normalizeChannel(input.channel);
    const key = preferenceKey(category, channel);
    if (seen.has(key)) {
      throw apiError("VALIDATION_FAILED", `Duplicate notification preference: ${key}`);
    }
    seen.add(key);
    if (typeof input.enabled !== "boolean") {
      throw apiError("VALIDATION_FAILED", `Notification preference ${key} requires enabled`);
    }
    if (channel !== "email" && input.emailDelivery !== undefined && input.emailDelivery !== null) {
      throw apiError(
        "VALIDATION_FAILED",
        "Email delivery is only valid for the email notification channel",
      );
    }
    const emailDelivery =
      channel === "email" && input.emailDelivery != null
        ? normalizeEmailDelivery(input.emailDelivery)
        : undefined;
    return { category, channel, enabled: input.enabled, emailDelivery };
  });
}

export function updateNotificationPreferences(
  db: Database,
  workspaceId: string,
  actorId: string,
  inputs: readonly NotificationPreferenceInput[],
): NotificationPreferenceRow[] {
  const normalized = normalizeInputs(inputs);
  db.transaction(() => {
    ensureRows(db, workspaceId, actorId);
    const existing = new Map(
      getRows(db, workspaceId, actorId).map((row) => [
        preferenceKey(row.category, row.channel),
        row,
      ]),
    );
    const update = db.query(
      `UPDATE notification_preferences
       SET enabled = ?1,
           email_delivery = CASE WHEN channel = 'email' THEN COALESCE(?2, email_delivery) ELSE NULL END,
           updated_at = ?3
       WHERE workspace_id = ?4 AND actor_id = ?5 AND category = ?6 AND channel = ?7`,
    );
    for (const item of normalized) {
      const key = preferenceKey(item.category, item.channel);
      const current = existing.get(key);
      const nextEmailDelivery =
        item.channel === "email"
          ? (item.emailDelivery ?? current?.email_delivery ?? "digest")
          : null;
      if (
        current &&
        current.enabled === (item.enabled ? 1 : 0) &&
        current.email_delivery === nextEmailDelivery
      ) {
        continue;
      }
      update.run(
        item.enabled ? 1 : 0,
        item.emailDelivery ?? null,
        now(),
        workspaceId,
        actorId,
        item.category,
        item.channel,
      );
    }
  })();
  return orderRows(getRows(db, workspaceId, actorId));
}

export function mapNotificationPreference(row: NotificationPreferenceRow): NotificationPreference {
  return {
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    category: row.category,
    channel: row.channel,
    enabled: row.enabled === 1,
    emailDelivery: row.email_delivery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
