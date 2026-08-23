// Dominio PostgreSQL de webhooks: registro, listado y baja.
import type { Persistence } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import type { WebhookRow } from "../webhooks/dispatcher.ts";
import { isWebhookEventName } from "../webhooks/events.ts";
import {
  assertCanAccessPostgresTeam,
  assertPostgresTeamActive,
  canAccessPostgresTeam,
  canWritePostgresTeam,
  getPostgresTeam,
} from "./postgres-teams.ts";

export type PostgresWebhookRow = WebhookRow & { workspace_id?: string | null };
type ViewerRef = { id: string; workspace_role: string };

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

function validateInput(input: { url: string; secret?: string | null; events?: string[] | null }): {
  url: string;
  secret: string;
  events: string[];
} {
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
  const secret =
    input.secret?.trim() ||
    Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  return { url: input.url, secret, events };
}

export function mapPostgresWebhook(row: PostgresWebhookRow) {
  return {
    id: row.id,
    url: row.url,
    events: parseEvents(row.events),
    enabled: row.enabled === true || row.enabled === 1,
    teamId: row.team_id,
    createdAt: row.created_at,
  };
}

export async function listPostgresWebhooks(
  persistence: Persistence,
  viewer: ViewerRef,
): Promise<PostgresWebhookRow[]> {
  const rows = await persistence.many<PostgresWebhookRow>(
    viewer.workspace_role === "admin"
      ? "SELECT * FROM webhooks ORDER BY created_at, id"
      : "SELECT * FROM webhooks WHERE owner_id = $1 ORDER BY created_at, id",
    viewer.workspace_role === "admin" ? undefined : [viewer.id],
  );
  if (viewer.workspace_role === "admin") return [...rows];
  const visible: PostgresWebhookRow[] = [];
  for (const row of rows) {
    if (!row.team_id || (await canAccessPostgresTeam(persistence, viewer, row.team_id))) {
      visible.push(row);
    }
  }
  return visible;
}

export async function createPostgresWebhook(
  persistence: Persistence,
  owner: ViewerRef,
  input: { url: string; secret?: string | null; events?: string[] | null; teamId?: string | null },
): Promise<{ row: PostgresWebhookRow; secret: string }> {
  const values = validateInput(input);
  const id = newId();
  const row = await persistence.one<PostgresWebhookRow>(
    `INSERT INTO webhooks
       (id, url, secret, events, enabled, created_at, owner_id, team_id)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7)
     RETURNING *`,
    [
      id,
      values.url,
      values.secret,
      JSON.stringify(values.events),
      now(),
      owner.id,
      input.teamId ?? null,
    ],
  );
  if (!row) throw apiError("VALIDATION_FAILED", "Webhook could not be created");
  return { row, secret: values.secret };
}

export async function deletePostgresWebhook(
  persistence: Persistence,
  id: string,
  viewer: ViewerRef,
): Promise<boolean> {
  const existing = await persistence.one<PostgresWebhookRow>(
    "SELECT * FROM webhooks WHERE id = $1",
    [id],
  );
  if (!existing) throw apiError("NOT_FOUND", "Webhook not found");
  if (viewer.workspace_role !== "admin" && existing.owner_id !== viewer.id) {
    throw apiError("UNAUTHORIZED", "You can only manage your own webhooks");
  }
  if (existing.team_id) {
    await assertCanAccessPostgresTeam(persistence, viewer, existing.team_id);
    if (!(await canWritePostgresTeam(persistence, viewer, existing.team_id))) {
      throw apiError("UNAUTHORIZED", "Team access policy does not allow webhook management");
    }
  }
  await persistence.execute("DELETE FROM webhooks WHERE id = $1", [id]);
  return true;
}

export async function assertCanCreatePostgresWebhook(
  persistence: Persistence,
  viewer: ViewerRef,
  teamId: string,
): Promise<void> {
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  await assertCanAccessPostgresTeam(persistence, viewer, teamId);
  await assertPostgresTeamActive(persistence, teamId);
  if (!(await canWritePostgresTeam(persistence, viewer, teamId))) {
    throw apiError("UNAUTHORIZED", "Team access policy does not allow webhook management");
  }
}
