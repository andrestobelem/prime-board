// Inbox (PRB-202/210): actividad relevante para el actor autenticado.
import { mutate, useQuery } from "../api.ts";
import { Link } from "../router.tsx";
import { Avatar } from "../components/bits.tsx";

interface InboxEntry {
  id: string;
  type: string;
  createdAt: string;
  isRead: boolean;
  isArchived: boolean;
  actor: { id: string; name: string; type: string };
  issue: { identifier: string; title: string };
  payload: Record<string, unknown>;
}

const QUERY = `{
  inbox(first: 50) {
    id type createdAt payload isRead isArchived
    actor { id name type }
    issue { identifier title }
  }
}`;

function summarize(entry: InboxEntry): string {
  switch (entry.type) {
    case "created":
      return "assigned this issue to you";
    case "assigned":
      return "assigned this issue to you";
    case "commented":
      return "commented";
    case "state_changed":
      return "changed the status";
    case "priority_changed":
      return "changed the priority";
    default:
      return entry.type.replace(/_/g, " ");
  }
}

export function InboxView() {
  const result = useQuery<{ inbox: InboxEntry[] }>(QUERY);

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;

  const items = result.data?.inbox ?? [];
  if (items.length === 0) {
    return <div className="empty">Inbox is empty.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {items.map((entry) => (
        <div
          key={entry.id}
          className="comment"
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            opacity: entry.isRead ? 0.7 : 1,
          }}
        >
          <Avatar actor={entry.actor} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              {!entry.isRead && <span className="label-chip">new</span>}{" "}
              <strong>{entry.actor.name}</strong>{" "}
              <span style={{ color: "var(--text-muted)" }}>{summarize(entry)}</span>
            </div>
            <Link to={`/issue/${entry.issue.identifier}`} style={{ fontSize: 13 }}>
              <code style={{ color: "var(--accent)" }}>{entry.issue.identifier}</code>{" "}
              {entry.issue.title}
            </Link>
            <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
              {!entry.isRead && (
                <button
                  className="btn secondary"
                  style={{ fontSize: 12, padding: "2px 8px" }}
                  onClick={() =>
                    void mutate(
                      `mutation($id: ID!) {
                      inboxMarkRead(id: $id) { success }
                    }`,
                      { id: entry.id },
                    )
                  }
                >
                  Mark read
                </button>
              )}
              <button
                className="btn secondary"
                style={{ fontSize: 12, padding: "2px 8px" }}
                onClick={() =>
                  void mutate(
                    `mutation($id: ID!) {
                    inboxArchive(id: $id) { success }
                  }`,
                    { id: entry.id },
                  )
                }
              >
                Archive
              </button>
            </div>
          </div>
          <span style={{ color: "var(--text-faint)", fontSize: 12, whiteSpace: "nowrap" }}>
            {entry.createdAt.slice(0, 10)}
          </span>
        </div>
      ))}
    </div>
  );
}
