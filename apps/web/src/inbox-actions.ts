export type InboxAction = "markRead" | "archive";

export type InboxMutationResponse =
  { inboxMarkRead: { success: boolean } } | { inboxArchive: { success: boolean } };

export type InboxMutation = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<InboxMutationResponse>;

const MARK_READ_MUTATION = `mutation($id: ID!) {
  inboxMarkRead(id: $id) { success }
}`;

const ARCHIVE_MUTATION = `mutation($id: ID!) {
  inboxArchive(id: $id) { success }
}`;

export async function executeInboxAction(
  id: string,
  action: InboxAction,
  mutation: InboxMutation,
): Promise<void> {
  const response = await mutation(action === "markRead" ? MARK_READ_MUTATION : ARCHIVE_MUTATION, {
    id,
  });
  const outcome =
    action === "markRead"
      ? "inboxMarkRead" in response
        ? response.inboxMarkRead
        : null
      : "inboxArchive" in response
        ? response.inboxArchive
        : null;
  if (!outcome?.success) throw new Error("The server did not update this inbox item.");
}

export type InboxActionState =
  | { kind: "pending"; action: InboxAction }
  | { kind: "error"; action: InboxAction; message: string };

export type InboxActionEvent =
  | { type: "started"; id: string; action: InboxAction }
  | { type: "succeeded"; id: string; action: InboxAction }
  | { type: "failed"; id: string; action: InboxAction; message: string };

export type InboxActionStates = Readonly<Record<string, InboxActionState>>;

export type InboxReceiptOverlay = { kind: "read" } | { kind: "archived" };
export type InboxReceiptOverlays = Readonly<Record<string, InboxReceiptOverlay>>;

export interface ReceiptEntry {
  id: string;
  isRead: boolean;
  isArchived: boolean;
}

export function transitionInboxActionState(
  states: InboxActionStates,
  event: InboxActionEvent,
): InboxActionStates {
  const current = states[event.id];
  if (
    event.type !== "started" &&
    (!current || current.kind !== "pending" || current.action !== event.action)
  )
    return states;
  if (event.type === "started" && current?.kind === "pending") return states;

  const next = { ...states };
  if (event.type === "succeeded") delete next[event.id];
  else if (event.type === "started") next[event.id] = { kind: "pending", action: event.action };
  else next[event.id] = { kind: "error", action: event.action, message: event.message };
  return next;
}

export function projectInboxEntries<T extends ReceiptEntry>(
  entries: readonly T[],
  overlays: InboxReceiptOverlays,
): T[] {
  return entries.flatMap((entry) => {
    const overlay = overlays[entry.id];
    if (entry.isArchived || overlay?.kind === "archived") return [];
    if (overlay?.kind === "read") return [{ ...entry, isRead: true }];
    return [entry];
  });
}

export function projectUnreadCount(
  serverCount: number | null,
  entries: readonly ReceiptEntry[],
  overlays: InboxReceiptOverlays,
): number {
  if (serverCount === null)
    return entries.filter((entry) => !entry.isArchived && !entry.isRead).length;
  const pendingUnreadReceipts = entries.filter((entry) => {
    const overlay = overlays[entry.id];
    return (
      !entry.isArchived &&
      !entry.isRead &&
      (overlay?.kind === "read" || overlay?.kind === "archived")
    );
  }).length;
  return Math.max(0, serverCount - pendingUnreadReceipts);
}

export function messageForInboxActionError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not update this inbox item. Try again.";
}
