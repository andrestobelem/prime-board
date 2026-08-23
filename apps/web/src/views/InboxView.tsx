// Inbox: actividad relevante para el actor autenticado.
import { useEffect, useMemo, useRef, useState } from "react";
import { gql, mutate, useQuery } from "../api.ts";
import { Link, navigate } from "../router.tsx";
import { Avatar } from "../components/bits.tsx";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState.tsx";
import { appendUniqueById } from "../pagination.ts";
import {
  executeInboxAction,
  messageForInboxActionError,
  projectInboxEntries,
  projectUnreadCount,
  transitionInboxActionState,
  type InboxAction,
  type InboxMutationResponse,
  type InboxActionEvent,
  type InboxActionState,
  type InboxReceiptOverlays,
} from "../inbox-actions.ts";

interface InboxEntry {
  id: string;
  type: string;
  createdAt: string;
  isRead: boolean;
  isArchived: boolean;
  actor: { id: string; name: string; type: string };
  issue: {
    identifier: string;
    title: string;
    priority: number;
    team: { key: string };
    project: { id: string; name: string } | null;
  };
  payload: Record<string, unknown>;
}

const QUERY = `query($after: String) {
  inboxUnreadCount
  inboxPage(first: 100, after: $after) {
    nodes {
      id type createdAt payload isRead isArchived
      actor { id name type }
      issue { identifier title priority team { key } project { id name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function summarize(entry: InboxEntry): string {
  switch (entry.type) {
    case "created":
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
  const result = useQuery<{
    inboxUnreadCount: number;
    inboxPage: {
      nodes: InboxEntry[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(QUERY);
  const [extraItems, setExtraItems] = useState<InboxEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    endCursor: null as string | null,
  });
  const pageGeneration = useRef(0);
  const pendingActions = useRef(new Set<string>());
  const [actionStates, setActionStates] = useState<Readonly<Record<string, InboxActionState>>>({});
  const [receiptOverlays, setReceiptOverlays] = useState<InboxReceiptOverlays>({});
  useEffect(() => {
    pageGeneration.current += 1;
    setExtraItems([]);
    setLoadingMore(false);
    setPageError(null);
    setPageInfo(result.data?.inboxPage.pageInfo ?? { hasNextPage: false, endCursor: null });
  }, [result.data?.inboxPage]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !pageInfo.hasNextPage || !pageInfo.endCursor) return;
    const generation = pageGeneration.current;
    setLoadingMore(true);
    setPageError(null);
    try {
      const next = await gql<{
        inboxPage: {
          nodes: InboxEntry[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(QUERY, { after: pageInfo.endCursor });
      if (generation !== pageGeneration.current) return;
      setExtraItems((current) => appendUniqueById(current, next.inboxPage.nodes));
      setPageInfo(next.inboxPage.pageInfo);
    } catch (err) {
      if (generation === pageGeneration.current) {
        setPageError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === pageGeneration.current) setLoadingMore(false);
    }
  }

  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [priority, setPriority] = useState("");
  const [team, setTeam] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);

  const sourceItems = appendUniqueById(result.data?.inboxPage.nodes ?? [], extraItems);
  const items = projectInboxEntries(sourceItems, receiptOverlays);
  const unreadCount = projectUnreadCount(
    result.data?.inboxUnreadCount ?? null,
    sourceItems,
    receiptOverlays,
  );
  const teams = [...new Set(items.map((entry) => entry.issue.team.key))].sort();
  const types = [...new Set(items.map((entry) => entry.type))].sort();
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((entry) => {
      if (unreadOnly && entry.isRead) return false;
      if (type && entry.type !== type) return false;
      if (priority && String(entry.issue.priority) !== priority) return false;
      if (team && entry.issue.team.key !== team) return false;
      return (
        !query ||
        `${entry.issue.identifier} ${entry.issue.title} ${entry.type}`.toLowerCase().includes(query)
      );
    });
  }, [items, search, type, priority, team, unreadOnly]);

  function updateActionState(event: InboxActionEvent): void {
    setActionStates((current) => transitionInboxActionState(current, event));
  }

  async function runReceiptAction(id: string, action: InboxAction): Promise<void> {
    // La referencia evita dos mutaciones antes del siguiente render.
    if (pendingActions.current.has(id)) return;
    pendingActions.current.add(id);
    updateActionState({ type: "started", id, action });
    try {
      await executeInboxAction(id, action, (query, variables) =>
        mutate<InboxMutationResponse>(query, variables),
      );
      setReceiptOverlays((current) => ({
        ...current,
        [id]: action === "markRead" ? { kind: "read" } : { kind: "archived" },
      }));
      updateActionState({ type: "succeeded", id, action });
    } catch (error: unknown) {
      updateActionState({
        type: "failed",
        id,
        action,
        message: messageForInboxActionError(error),
      });
    } finally {
      pendingActions.current.delete(id);
    }
  }

  function markRead(id: string): void {
    void runReceiptAction(id, "markRead");
  }

  function archive(id: string): void {
    void runReceiptAction(id, "archive");
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)
      )
        return;
      if (event.key === "j" || event.key === "ArrowDown")
        setFocusIndex((index) => Math.min(index + 1, filtered.length - 1));
      if (event.key === "k" || event.key === "ArrowUp")
        setFocusIndex((index) => Math.max(index - 1, 0));
      if (event.key === "Enter" && filtered[focusIndex])
        navigate(`/issue/${filtered[focusIndex].issue.identifier}`);
      if (event.key.toLowerCase() === "u" && filtered[focusIndex]) {
        markRead(filtered[focusIndex].id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, focusIndex]);

  if (result.loading && !result.data) return <LoadingState />;
  if (result.error) return <ErrorState message={result.error.message} onRetry={result.refetch} />;
  if (items.length === 0)
    return (
      <EmptyState
        title="Inbox is empty"
        description="New assignments and comments will appear here."
      />
    );

  return (
    <div className="inbox-view">
      <div className="inbox-toolbar" aria-label="Inbox filters">
        <strong>{unreadCount} unread</strong>
        <input
          aria-label="Search inbox"
          placeholder="Search inbox"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Filter inbox by type"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="">All activity</option>
          {types.map((item) => (
            <option key={item} value={item}>
              {item.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter inbox by priority"
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        >
          <option value="">Any priority</option>
          <option value="1">Urgent</option>
          <option value="2">High</option>
          <option value="3">Medium</option>
          <option value="4">Low</option>
        </select>
        <select
          aria-label="Filter inbox by team"
          value={team}
          onChange={(event) => setTeam(event.target.value)}
        >
          <option value="">All teams</option>
          {teams.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <label className="inbox-unread-toggle">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />{" "}
          Unread
        </label>
      </div>
      {pageError && (
        <div className="error-banner" role="alert">
          {pageError}{" "}
          <button className="btn secondary" onClick={() => void loadMore()}>
            Retry
          </button>
        </div>
      )}
      {(pageInfo.hasNextPage || loadingMore) && (
        <div className="pagination-notice">
          <button className="btn secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {filtered.length === 0 ? (
        <EmptyState
          title="No inbox items match"
          description="Try a broader search or clear a filter."
          action={{
            label: "Clear filters",
            onClick: () => {
              setSearch("");
              setType("");
              setPriority("");
              setTeam("");
              setUnreadOnly(false);
            },
          }}
        />
      ) : (
        filtered.map((entry, index) => {
          const actionState = actionStates[entry.id];
          const isPending = actionState?.kind === "pending";
          return (
            <div
              key={entry.id}
              className={`comment inbox-entry${index === focusIndex ? " focused" : ""}`}
              tabIndex={index === focusIndex ? 0 : -1}
              aria-current={index === focusIndex ? "true" : undefined}
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
                      onClick={() => markRead(entry.id)}
                      disabled={isPending}
                    >
                      {isPending && actionState.action === "markRead" ? "Marking…" : "Mark read"}
                    </button>
                  )}
                  <button
                    className="btn secondary"
                    onClick={() => archive(entry.id)}
                    disabled={isPending}
                  >
                    {isPending && actionState.action === "archive" ? "Archiving…" : "Archive"}
                  </button>
                </div>
                {actionState?.kind === "error" && (
                  <div className="inbox-action-error" role="alert">
                    {actionState.message}{" "}
                    <button
                      className="btn secondary"
                      onClick={() => void runReceiptAction(entry.id, actionState.action)}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
              <span style={{ color: "var(--text-faint)", fontSize: 12, whiteSpace: "nowrap" }}>
                {entry.createdAt.slice(0, 10)}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
