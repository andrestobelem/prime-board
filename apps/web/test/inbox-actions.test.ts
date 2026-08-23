import { describe, expect, it } from "bun:test";
import {
  executeInboxAction,
  messageForInboxActionError,
  projectInboxEntries,
  projectUnreadCount,
  transitionInboxActionState,
  type InboxReceiptOverlays,
} from "../src/inbox-actions.ts";

const unreadEntry = { id: "unread", isRead: false, isArchived: false };
const readEntry = { id: "read", isRead: true, isArchived: false };
const entries = [unreadEntry, readEntry];

describe("inbox receipt actions", () => {
  it("envía la mutación correcta y acepta un éxito del servidor", async () => {
    const calls: Array<{ query: string; id: unknown }> = [];
    await executeInboxAction("unread", "markRead", async (query, variables) => {
      calls.push({ query, id: variables.id });
      return { inboxMarkRead: { success: true } };
    });
    expect(calls).toEqual([{ query: expect.stringContaining("inboxMarkRead"), id: "unread" }]);
  });

  it("propaga un rechazo de permisos y conserva la acción recuperable", async () => {
    await expect(
      executeInboxAction("unread", "archive", async () => {
        throw new Error("Not authorized");
      }),
    ).rejects.toThrow("Not authorized");
  });

  it("propaga un error de red sin cambiar la entrada", async () => {
    await expect(
      executeInboxAction("unread", "markRead", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("rechaza una respuesta sin éxito aunque la red responda", async () => {
    await expect(
      executeInboxAction("unread", "archive", async () => ({
        inboxArchive: { success: false },
      })),
    ).rejects.toThrow("The server did not update this inbox item.");
  });

  it("muestra pending y bloquea un segundo inicio para la misma entrada", () => {
    const pending = transitionInboxActionState(
      {},
      { type: "started", id: "unread", action: "archive" },
    );
    expect(
      transitionInboxActionState(pending, {
        type: "started",
        id: "unread",
        action: "markRead",
      }),
    ).toBe(pending);
    expect(pending.unread).toEqual({ kind: "pending", action: "archive" });
  });

  it("aplica el éxito de mark read al estado local y al contador", () => {
    const pending = transitionInboxActionState(
      {},
      {
        type: "started",
        id: "unread",
        action: "markRead",
      },
    );
    expect(
      transitionInboxActionState(pending, {
        type: "succeeded",
        id: "unread",
        action: "markRead",
      }),
    ).toEqual({});
    const overlays: InboxReceiptOverlays = { unread: { kind: "read" } };
    expect(projectInboxEntries(entries, overlays)).toEqual([
      { id: "unread", isRead: true, isArchived: false },
      readEntry,
    ]);
    expect(projectUnreadCount(1, entries, overlays)).toBe(0);
  });

  it("quita la entrada y descuenta un unread después de archivar con éxito", () => {
    const overlays: InboxReceiptOverlays = { unread: { kind: "archived" } };
    expect(projectInboxEntries(entries, overlays)).toEqual([readEntry]);
    expect(projectUnreadCount(1, entries, overlays)).toBe(0);
  });

  it("mantiene la entrada y permite Retry después de un permiso insuficiente", () => {
    const pending = transitionInboxActionState(
      {},
      { type: "started", id: "unread", action: "markRead" },
    );
    const failed = transitionInboxActionState(pending, {
      type: "failed",
      id: "unread",
      action: "markRead",
      message: "Not authorized",
    });
    expect(failed.unread).toEqual({ kind: "error", action: "markRead", message: "Not authorized" });
    expect(projectInboxEntries(entries, {})).toEqual(entries);
    expect(projectUnreadCount(1, entries, {})).toBe(1);
  });

  it("conserva el estado y muestra un mensaje recuperable ante error de red", () => {
    const pending = transitionInboxActionState(
      {},
      { type: "started", id: "unread", action: "archive" },
    );
    const failed = transitionInboxActionState(pending, {
      type: "failed",
      id: "unread",
      action: "archive",
      message: messageForInboxActionError(new TypeError("Failed to fetch")),
    });
    expect(failed.unread).toEqual({
      kind: "error",
      action: "archive",
      message: "Failed to fetch",
    });
    expect(projectInboxEntries(entries, {})).toEqual(entries);
    expect(projectUnreadCount(1, entries, {})).toBe(1);
  });

  it("ignora entradas ya archivadas y no crea un contador negativo", () => {
    const archived = { id: "archived", isRead: false, isArchived: true };
    expect(projectInboxEntries([archived], {})).toEqual([]);
    expect(projectUnreadCount(0, [archived], {})).toBe(0);
    expect(projectUnreadCount(null, [archived], {})).toBe(0);
  });

  it("ignora una respuesta terminada de una acción que ya no está pending", () => {
    const state = transitionInboxActionState(
      {},
      { type: "started", id: "unread", action: "markRead" },
    );
    expect(
      transitionInboxActionState(state, {
        type: "succeeded",
        id: "unread",
        action: "archive",
      }),
    ).toBe(state);
    expect(messageForInboxActionError("network down")).toBe(
      "Could not update this inbox item. Try again.",
    );
  });
});
