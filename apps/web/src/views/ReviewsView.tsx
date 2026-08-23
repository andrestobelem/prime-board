// Cola de reviews (PRB-205/217): filtros team/proyecto/agente/edad.
import { useEffect, useRef, useState } from "react";
import { gql, GqlError, mutate, useQuery } from "../api.ts";
import { Avatar } from "../components/bits.tsx";
import { ErrorState } from "../components/AsyncState.tsx";
import { appendUniqueById } from "../pagination.ts";
import { createRequestGate } from "../request-generation.ts";
import { EntityModal } from "../components/EntityModal.tsx";
import { Link } from "../router.tsx";

interface ReviewItem {
  id: string;
  status: string;
  createdAt: string;
  requester: { id: string; name: string; type: string };
  reviewer: { id: string; name: string; type: string };
  issue: { identifier: string; title: string };
}

interface ReviewPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ReviewsData {
  reviews: { nodes: ReviewItem[]; pageInfo: ReviewPageInfo };
}

const STATUS_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "IN_PROGRESS", label: "In progress" },
  { status: "APPROVED", label: "Approve" },
  { status: "REJECTED", label: "Reject" },
  { status: "REQUESTED", label: "Re-request" },
];

export function ReviewsView() {
  const [openOnly, setOpenOnly] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [olderThanDays, setOlderThanDays] = useState("");
  const [requestOpen, setRequestOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraItems, setExtraItems] = useState<ReviewItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageInfo, setPageInfo] = useState<ReviewPageInfo>({
    hasNextPage: false,
    endCursor: null,
  });
  const pageGate = useRef(createRequestGate());

  const meta = useQuery<{
    actors: Array<{ id: string; name: string; type: string }>;
    teams: Array<{ id: string; key: string; name: string }>;
    projects: Array<{ id: string; name: string }>;
  }>(`{
    actors { id name type }
    teams { id key name }
    projects { id name }
  }`);

  const filterVars: Record<string, unknown> = {
    openOnly,
    first: 50,
  };
  if (teamId) filterVars.teamId = teamId;
  if (projectId) filterVars.projectId = projectId;
  if (reviewerId) filterVars.reviewerId = reviewerId;
  if (olderThanDays.trim() && Number(olderThanDays) > 0) {
    filterVars.olderThanDays = Number(olderThanDays);
  }

  const REVIEWS_QUERY = `query(
    $openOnly: Boolean, $first: Int, $after: String,
    $teamId: ID, $projectId: ID, $reviewerId: ID, $olderThanDays: Int
  ) {
    reviews(
      openOnly: $openOnly, first: $first, after: $after,
      teamId: $teamId, projectId: $projectId,
      reviewerId: $reviewerId, olderThanDays: $olderThanDays
    ) {
      nodes {
        id status createdAt
        requester { id name type }
        reviewer { id name type }
        issue { identifier title }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const result = useQuery<ReviewsData>(REVIEWS_QUERY, filterVars);
  const pageKey = JSON.stringify(filterVars);

  useEffect(() => {
    pageGate.current.next();
    setExtraItems([]);
    setLoadingMore(false);
    setPageError(null);
    if (result.data?.reviews.pageInfo) setPageInfo(result.data.reviews.pageInfo);
  }, [pageKey, result.data]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !pageInfo.hasNextPage || !pageInfo.endCursor) return;
    const generation = pageGate.current.next();
    setLoadingMore(true);
    setPageError(null);
    try {
      const next = await gql<ReviewsData>(REVIEWS_QUERY, {
        ...filterVars,
        after: pageInfo.endCursor,
      });
      if (!pageGate.current.isCurrent(generation)) return;
      setExtraItems((current) => appendUniqueById(current, next.reviews.nodes));
      setPageInfo(next.reviews.pageInfo);
    } catch (loadError) {
      if (pageGate.current.isCurrent(generation)) {
        setPageError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (pageGate.current.isCurrent(generation)) setLoadingMore(false);
    }
  }

  async function setStatus(id: string, status: string) {
    setError(null);
    try {
      await mutate(
        `mutation($id: ID!, $status: ReviewStatus!) {
        reviewUpdate(id: $id, input: { status: $status }) { review { id status } }
      }`,
        { id, status },
      );
    } catch (err) {
      setError(err instanceof GqlError ? err.message : String(err));
    }
  }

  async function requestReview(values: Record<string, string>) {
    const issueRef = values.issueRef?.trim();
    if (!issueRef) throw new Error("Issue identifier is required");
    if (!values.reviewerId) throw new Error("Reviewer is required");
    setError(null);
    await mutate(
      `mutation($input: ReviewCreateInput!) {
      reviewCreate(input: $input) { review { id } }
    }`,
      { input: { issueId: issueRef, reviewerId: values.reviewerId } },
    );
    setRequestOpen(false);
  }

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <ErrorState message={result.error.message} onRetry={result.refetch} />;

  const items = [...(result.data?.reviews.nodes ?? []), ...extraItems];
  const selectStyle = { fontSize: 12, maxWidth: 160 } as const;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(event) => setOpenOnly(event.target.checked)}
          />
          Open only
        </label>
        <select
          style={selectStyle}
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
        >
          <option value="">All teams</option>
          {(meta.data?.teams ?? []).map((team) => (
            <option key={team.id} value={team.id}>
              {team.key}
            </option>
          ))}
        </select>
        <select
          style={selectStyle}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">All projects</option>
          {(meta.data?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          style={selectStyle}
          value={reviewerId}
          onChange={(event) => setReviewerId(event.target.value)}
        >
          <option value="">All reviewers</option>
          {(meta.data?.actors ?? []).map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </select>
        <input
          style={{ ...selectStyle, width: 72 }}
          type="number"
          min={1}
          placeholder="Age days"
          value={olderThanDays}
          onChange={(event) => setOlderThanDays(event.target.value)}
          title="Older than N days"
        />
        <span style={{ color: "var(--text-muted)", fontSize: 13, flex: 1 }}>
          Reviews where you are requester or reviewer
        </span>
        <button className="btn" onClick={() => setRequestOpen(true)}>
          Request review
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {items.length === 0 ? (
        <div className="empty">No reviews yet.</div>
      ) : (
        items.map((review) => (
          <div
            key={review.id}
            className="comment"
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <Avatar actor={review.reviewer} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>
                <strong>{review.requester.name}</strong>{" "}
                <span style={{ color: "var(--text-muted)" }}>asked</span>{" "}
                <strong>{review.reviewer.name}</strong>{" "}
                <span className="label-chip">{review.status.toLowerCase().replace("_", " ")}</span>
              </div>
              <Link to={`/issue/${review.issue.identifier}`} style={{ fontSize: 13 }}>
                <code style={{ color: "var(--accent)" }}>{review.issue.identifier}</code>{" "}
                {review.issue.title}
              </Link>
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {STATUS_ACTIONS.filter((action) => action.status !== review.status).map(
                  (action) => (
                    <button
                      key={action.status}
                      className="btn secondary"
                      style={{ fontSize: 12, padding: "2px 8px" }}
                      onClick={() => void setStatus(review.id, action.status)}
                    >
                      {action.label}
                    </button>
                  ),
                )}
              </div>
            </div>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {review.createdAt.slice(0, 10)}
            </span>
          </div>
        ))
      )}
      {pageError && (
        <div className="error-banner" role="alert">
          {pageError}{" "}
          <button className="btn secondary" onClick={() => void loadMore()}>
            Retry
          </button>
        </div>
      )}
      {(pageInfo.hasNextPage || loadingMore) && (
        <div style={{ padding: 16, textAlign: "center" }}>
          <button className="btn secondary" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {requestOpen && (
        <EntityModal
          title="Request review"
          submitLabel="Request review"
          fields={[
            { key: "issueRef", label: "Issue", placeholder: "Issue identifier (e.g. PRB-1)" },
            {
              key: "reviewerId",
              label: "Reviewer",
              type: "select",
              value: meta.data?.actors[0]?.id ?? "",
              options: (meta.data?.actors ?? []).map((actor) => ({
                value: actor.id,
                label: `${actor.name}${actor.type === "AGENT" ? " (agent)" : ""}`,
              })),
            },
          ]}
          onClose={() => setRequestOpen(false)}
          onSubmit={requestReview}
        />
      )}
    </div>
  );
}
