/** Eventos públicos que puede suscribir un webhook. */
export const WEBHOOK_EVENT_NAMES = [
  "issue.created",
  "issue.updated",
  "issue.archived",
  "comment.created",
  "project.created",
  "project.updated",
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENT_NAMES)[number];

export function isWebhookEventName(value: string): value is WebhookEventName {
  return (WEBHOOK_EVENT_NAMES as readonly string[]).includes(value);
}
